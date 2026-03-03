import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

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

async function hashPayload(value: unknown) {
  const text = JSON.stringify(value || {});
  const hashBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

function pickString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

async function notifyDocumentReady(requestRow: Record<string, unknown>) {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  if (!supabaseUrl) return;
  const recipients = Array.from(new Set([
    "diretor@einsteinhub.co",
    "secretaria@einsteinhub.co",
    String(requestRow.requester_email || "").toLowerCase()
  ].filter(Boolean)));

  const payload = {
    event_type: "documento_pronto",
    request_id: String(requestRow.id || ""),
    protocol: String(requestRow.protocol || "não informado"),
    document_label: String(requestRow.document_other || requestRow.document_type || "Documento não informado"),
    user_name: String(requestRow.requester_name || "Usuário"),
    user_email: String(requestRow.requester_email || ""),
    profile: String(requestRow.form_type || "aluno"),
    status: String(requestRow.status || "documento_pronto"),
    destination_emails: recipients,
    force_refresh_signed_document: true
  };

  const response = await fetch(`${supabaseUrl}/functions/v1/send-workflow-email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Falha ao enviar e-mail documento_pronto: HTTP ${response.status} ${errorBody}`);
  }
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

  let eventLogId: number | null = null;
  const supabase = adminClient();

  try {
    const url = new URL(req.url);
    const expectedToken = Deno.env.get("CLICKSIGN_WEBHOOK_TOKEN");
    if (expectedToken) {
      const receivedToken = url.searchParams.get("token");
      if (receivedToken !== expectedToken) {
        return new Response(JSON.stringify({ ok: false, error: "Webhook token inválido." }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }
    }

    const payload = await req.json();
    const eventName = pickString(
      payload?.event?.name,
      payload?.name,
      payload?.event_name,
      payload?.type,
      "unknown_event"
    );
    const protocol = pickString(payload?.protocol, payload?.event?.data?.protocol, "nao_informado");
    const documentId = pickString(
      payload?.document?.id,
      payload?.event?.data?.document?.id,
      payload?.event?.data?.document_id,
      payload?.document_id
    );
    const envelopeId = pickString(
      payload?.document?.envelope_id,
      payload?.event?.data?.envelope?.id,
      payload?.event?.data?.envelope_id,
      payload?.envelope_id
    );
    const signerId = pickString(
      payload?.event?.data?.signer?.id,
      payload?.signer?.id,
      payload?.signer_id
    );
    const signerEmail = pickString(
      payload?.event?.data?.user?.email,
      payload?.signer?.email,
      payload?.user?.email
    ).toLowerCase();

    const eventId = pickString(payload?.event?.id, payload?.id) || await hashPayload(payload);

    const { data: existingEvent } = await supabase
      .from("lp_clicksign_events")
      .select("id, processing_status")
      .eq("event_id", eventId)
      .maybeSingle();

    if (existingEvent) {
      return new Response(JSON.stringify({ ok: true, duplicate: true }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    let requestRow: Record<string, unknown> | null = null;
    if (documentId) {
      const byDocument = await supabase
        .from("lp_document_requests")
        .select("*")
        .eq("clicksign_document_id", documentId)
        .maybeSingle();
      requestRow = byDocument.data as Record<string, unknown> | null;
    }
    if (!requestRow && envelopeId) {
      const byEnvelope = await supabase
        .from("lp_document_requests")
        .select("*")
        .eq("clicksign_envelope_id", envelopeId)
        .maybeSingle();
      requestRow = byEnvelope.data as Record<string, unknown> | null;
    }

    const insertEvent = await supabase
      .from("lp_clicksign_events")
      .insert({
        event_id: eventId,
        request_id: requestRow?.id || null,
        protocol: requestRow?.protocol || protocol,
        event_name: eventName,
        payload: payload,
        processing_status: "received"
      })
      .select("id")
      .single();

    if (!insertEvent.error) {
      eventLogId = insertEvent.data?.id || null;
    }

    if (!requestRow) {
      if (eventLogId) {
        await supabase
          .from("lp_clicksign_events")
          .update({ processing_status: "ignored", processed_at: new Date().toISOString() })
          .eq("id", eventLogId);
      }
      return new Response(JSON.stringify({ ok: true, ignored: "request_not_found" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    const nowIso = new Date().toISOString();
    const currentStatus = String(requestRow.status || "");
    const updateData: Record<string, unknown> = {
      clicksign_last_event: eventName,
      clicksign_status: eventName
    };

    const adminEmail = String(Deno.env.get("CLICKSIGN_SIGNER_ADMIN_EMAIL") || "diretor@einsteinhub.co").toLowerCase();
    const secretariaEmail = String(Deno.env.get("CLICKSIGN_SIGNER_SECRETARIA_EMAIL") || "secretaria@einsteinhub.co").toLowerCase();
    const isSignEvent = eventName === "sign";

    const adminSignerId = String(requestRow.clicksign_signer_admin_id || "");
    const secretariaSignerId = String(requestRow.clicksign_signer_secretaria_id || "");
    const signerMatchesAdmin = (signerId && signerId === adminSignerId) || (signerEmail && signerEmail === adminEmail);
    const signerMatchesSecretaria = (signerId && signerId === secretariaSignerId) || (signerEmail && signerEmail === secretariaEmail);

    if (isSignEvent && signerMatchesAdmin) {
      updateData.signed_by_admin = true;
      updateData.clicksign_signed_admin_at = nowIso;
    }
    if (isSignEvent && signerMatchesSecretaria) {
      updateData.signed_by_secretaria = true;
      updateData.clicksign_signed_secretaria_at = nowIso;
    }

    const signedByAdmin = Boolean(updateData.signed_by_admin ?? requestRow.signed_by_admin);
    const signedBySecretaria = Boolean(updateData.signed_by_secretaria ?? requestRow.signed_by_secretaria);
    const shouldSetReady = currentStatus === "assinaturas_pendentes" && signedByAdmin && signedBySecretaria;

    if (shouldSetReady) {
      updateData.status = "documento_pronto";
      updateData.signed_at = nowIso;
    }

    const { data: updatedRequest, error: requestUpdateError } = await supabase
      .from("lp_document_requests")
      .update(updateData)
      .eq("id", requestRow.id)
      .select("*")
      .single();

    if (requestUpdateError) {
      throw new Error(requestUpdateError.message);
    }

    if (shouldSetReady) {
      await supabase.from("lp_request_status_history").insert({
        request_id: updatedRequest.id,
        protocol: updatedRequest.protocol,
        old_status: "assinaturas_pendentes",
        new_status: "documento_pronto",
        changed_by: "clicksign_webhook",
        changed_by_email: signerEmail || null,
        notes: "Ambas assinaturas confirmadas via webhook Clicksign.",
        metadata: {
          event_name: eventName,
          signer_email: signerEmail || null,
          signer_id: signerId || null
        }
      });
      try {
        await notifyDocumentReady(updatedRequest as Record<string, unknown>);
      } catch (notifyError) {
        console.error("Falha ao notificar documento pronto:", notifyError);
      }
    }

    if (eventLogId) {
      await supabase
        .from("lp_clicksign_events")
        .update({ processing_status: "processed", processed_at: new Date().toISOString() })
        .eq("id", eventLogId);
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Falha desconhecida no webhook.";

    if (eventLogId) {
      await supabase
        .from("lp_clicksign_events")
        .update({
          processing_status: "error",
          error_message: message,
          processed_at: new Date().toISOString()
        })
        .eq("id", eventLogId);
    }

    return new Response(JSON.stringify({ ok: false, error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
});
