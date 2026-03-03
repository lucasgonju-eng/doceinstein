import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

type StartPayload = {
  request_id?: string;
  produced_document_path?: string;
  produced_document_name?: string;
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

function adminClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY não configurados.");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

function clicksignBaseUrl() {
  return (Deno.env.get("CLICKSIGN_BASE_URL") || "https://sandbox.clicksign.com/api/v3").replace(/\/+$/, "");
}

function clicksignAuthHeaders() {
  const rawToken = (Deno.env.get("CLICKSIGN_ACCESS_TOKEN") || "").trim();
  if (!rawToken) throw new Error("CLICKSIGN_ACCESS_TOKEN não configurado.");
  if (/^SEU_TOKEN|YOUR_TOKEN|TOKEN_AQUI/i.test(rawToken)) {
    throw new Error("CLICKSIGN_ACCESS_TOKEN está com valor placeholder. Configure o token real da Clicksign.");
  }
  return /^Bearer\s+/i.test(rawToken)
    ? [rawToken]
    : [rawToken, `Bearer ${rawToken}`];
}

async function clicksignRequest(path: string, method: string, body?: unknown) {
  const authHeaders = clicksignAuthHeaders();
  let lastStatus = 0;
  let lastParsed: unknown = {};
  for (const authorization of authHeaders) {
    const response = await fetch(`${clicksignBaseUrl()}${path}`, {
      method,
      headers: {
        Authorization: authorization,
        Accept: "application/vnd.api+json",
        "Content-Type": "application/vnd.api+json"
      },
      body: body ? JSON.stringify(body) : undefined
    });

    const text = await response.text();
    const parsed = text ? (() => { try { return JSON.parse(text); } catch { return { raw: text }; } })() : {};
    if (response.ok) {
      return parsed as Record<string, unknown>;
    }
    lastStatus = response.status;
    lastParsed = parsed;
    if (response.status !== 401) {
      break;
    }
  }
  throw new Error(`Clicksign ${method} ${path} -> HTTP ${lastStatus}: ${JSON.stringify(lastParsed)}`);
}

function extractId(result: Record<string, unknown>): string | null {
  const data = (result?.data || null) as Record<string, unknown> | null;
  const id = data?.id;
  return typeof id === "string" ? id : null;
}

async function downloadAsBase64(signedUrl: string) {
  const response = await fetch(signedUrl);
  if (!response.ok) throw new Error(`Falha ao baixar PDF produzido: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Método não permitido." }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }

  try {
    const payload = (await req.json()) as StartPayload;
    if (!payload.request_id) {
      return new Response(JSON.stringify({ error: "request_id é obrigatório." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    const supabase = adminClient();
    const { data: requestRow, error: requestError } = await supabase
      .from("lp_document_requests")
      .select("*")
      .eq("id", payload.request_id)
      .single();

    if (requestError || !requestRow) {
      throw new Error(`Pedido não encontrado: ${requestError?.message || payload.request_id}`);
    }

    const producedPath = payload.produced_document_path || requestRow.payload?.produced_document_path;
    if (!producedPath) {
      throw new Error("PDF produzido não encontrado. Faça upload na aba Produção antes de iniciar assinaturas.");
    }

    const producedName = payload.produced_document_name || requestRow.payload?.produced_document_name || "documento-final.pdf";

    const signedUrlResult = await supabase.storage
      .from("id_autorizacao_enviados")
      .createSignedUrl(producedPath, 60 * 30);
    if (signedUrlResult.error || !signedUrlResult.data?.signedUrl) {
      throw new Error(`Não foi possível obter URL do PDF produzido: ${signedUrlResult.error?.message || "URL inválida"}`);
    }
    const fileBase64 = await downloadAsBase64(signedUrlResult.data.signedUrl);

    const envelopeBody = {
      data: {
        type: "envelopes",
        attributes: {
          name: `DOC-Einstein ${requestRow.protocol}`,
          locale: "pt-BR"
        }
      }
    };
    const envelopeResult = await clicksignRequest("/envelopes", "POST", envelopeBody);
    const envelopeId = extractId(envelopeResult);
    if (!envelopeId) throw new Error("Clicksign: envelope sem ID no retorno.");

    const documentBody = {
      data: {
        type: "documents",
        attributes: {
          filename: producedName,
          content_base64: `data:application/pdf;base64,${fileBase64}`,
          metadata: {
            protocol: requestRow.protocol,
            request_id: requestRow.id
          }
        }
      }
    };
    const documentResult = await clicksignRequest(`/envelopes/${envelopeId}/documents`, "POST", documentBody);
    const documentId = extractId(documentResult);
    if (!documentId) throw new Error("Clicksign: documento sem ID no retorno.");

    const adminEmail = (Deno.env.get("CLICKSIGN_SIGNER_ADMIN_EMAIL") || "diretor@einsteinhub.co").toLowerCase();
    const adminName = Deno.env.get("CLICKSIGN_SIGNER_ADMIN_NAME") || "Diretoria Einstein";
    const secretariaEmail = (Deno.env.get("CLICKSIGN_SIGNER_SECRETARIA_EMAIL") || "secretaria@einsteinhub.co").toLowerCase();
    const secretariaName = Deno.env.get("CLICKSIGN_SIGNER_SECRETARIA_NAME") || "Secretaria Einstein";

    const adminSignerResult = await clicksignRequest(`/envelopes/${envelopeId}/signers`, "POST", {
      data: {
        type: "signers",
        attributes: { name: adminName, email: adminEmail }
      }
    });
    const adminSignerId = extractId(adminSignerResult);
    if (!adminSignerId) throw new Error("Clicksign: signatário admin sem ID.");

    const secretariaSignerResult = await clicksignRequest(`/envelopes/${envelopeId}/signers`, "POST", {
      data: {
        type: "signers",
        attributes: { name: secretariaName, email: secretariaEmail }
      }
    });
    const secretariaSignerId = extractId(secretariaSignerResult);
    if (!secretariaSignerId) throw new Error("Clicksign: signatário secretaria sem ID.");

    const createQualificationRequirement = async (signerId: string) =>
      clicksignRequest(`/envelopes/${envelopeId}/requirements`, "POST", {
        data: {
          type: "requirements",
          attributes: {
            action: "agree",
            role: "party"
          },
          relationships: {
            document: { data: { type: "documents", id: documentId } },
            signer: { data: { type: "signers", id: signerId } }
          }
        }
      });

    const createAuthRequirement = async (signerId: string) => {
      const attempts = [
        {
          data: {
            type: "requirements",
            attributes: {
              action: "provide_evidence",
              auth: "email"
            },
            relationships: {
              signer: { data: { type: "signers", id: signerId } }
            }
          }
        },
        {
          data: {
            type: "requirements",
            attributes: {
              action: "authenticate",
              auth: "email"
            },
            relationships: {
              signer: { data: { type: "signers", id: signerId } }
            }
          }
        },
        {
          data: {
            type: "requirements",
            attributes: {
              action: "provide_evidence",
              auth: "email"
            },
            relationships: {
              document: { data: { type: "documents", id: documentId } },
              signer: { data: { type: "signers", id: signerId } }
            }
          }
        }
      ];

      const errors: string[] = [];
      for (const body of attempts) {
        try {
          await clicksignRequest(`/envelopes/${envelopeId}/requirements`, "POST", body);
          return;
        } catch (error) {
          errors.push(error instanceof Error ? error.message : "erro desconhecido");
        }
      }
      throw new Error(`Não foi possível criar requisito de autenticação: ${errors.join(" | ")}`);
    };

    await createQualificationRequirement(adminSignerId);
    await createQualificationRequirement(secretariaSignerId);
    await createAuthRequirement(adminSignerId);
    await createAuthRequirement(secretariaSignerId);

    await clicksignRequest(`/envelopes/${envelopeId}`, "PATCH", {
      data: {
        type: "envelopes",
        id: envelopeId,
        attributes: { status: "running" }
      }
    });

    try {
      const webhookUrl = Deno.env.get("CLICKSIGN_WEBHOOK_URL");
      if (webhookUrl) {
        const webhookEvents = ["sign", "close", "auto_close", "cancel", "refusal"];
        await clicksignRequest("/webhooks", "POST", {
          data: {
            type: "webhooks",
            attributes: {
              endpoint: webhookUrl,
              url: webhookUrl,
              events: webhookEvents
            }
          }
        });
      }
    } catch (webhookError) {
      console.error("Falha ao garantir webhook Clicksign:", webhookError);
    }

    const nowIso = new Date().toISOString();
    const mergedPayload = {
      ...(requestRow.payload || {}),
      produced_document_path: producedPath,
      produced_document_name: producedName,
      clicksign: {
        envelope_id: envelopeId,
        document_id: documentId,
        signer_admin_id: adminSignerId,
        signer_secretaria_id: secretariaSignerId,
        signer_admin_email: adminEmail,
        signer_secretaria_email: secretariaEmail,
        started_at: nowIso
      }
    };

    const { data: updatedRequest, error: updateError } = await supabase
      .from("lp_document_requests")
      .update({
        status: "assinaturas_pendentes",
        production_ready_at: nowIso,
        clicksign_envelope_id: envelopeId,
        clicksign_document_id: documentId,
        clicksign_signer_admin_id: adminSignerId,
        clicksign_signer_secretaria_id: secretariaSignerId,
        clicksign_status: "running",
        clicksign_last_event: "assinaturas_pendentes",
        signed_by_admin: false,
        signed_by_secretaria: false,
        payload: mergedPayload
      })
      .eq("id", payload.request_id)
      .select("*")
      .single();

    if (updateError || !updatedRequest) {
      throw new Error(`Falha ao atualizar pedido após Clicksign: ${updateError?.message}`);
    }

    await supabase.from("lp_request_status_history").insert({
      request_id: updatedRequest.id,
      protocol: updatedRequest.protocol,
      old_status: requestRow.status,
      new_status: "assinaturas_pendentes",
      changed_by: "system_clicksign",
      changed_by_email: null,
      notes: "Documento enviado para assinaturas pendentes via Clicksign.",
      metadata: {
        clicksign_envelope_id: envelopeId,
        clicksign_document_id: documentId,
        produced_document_path: producedPath
      }
    });

    return new Response(
      JSON.stringify({
        ok: true,
        request: updatedRequest
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Falha desconhecida.";
    return new Response(JSON.stringify({ ok: false, error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
});
