import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

type RequestPayload = {
  request_id?: string;
  role?: "admin" | "secretaria";
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

function clicksignAppOrigin() {
  const base = clicksignBaseUrl().replace(/\/api\/v\d+\/?$/i, "");
  return base.replace(/\/+$/, "");
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

function collectStringUrls(value: unknown, maxDepth = 5, depth = 0, acc: string[] = []): string[] {
  if (depth > maxDepth || value == null) return acc;
  if (typeof value === "string") {
    if (value.startsWith("http://") || value.startsWith("https://")) {
      acc.push(value);
    }
    return acc;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStringUrls(item, maxDepth, depth + 1, acc);
    return acc;
  }
  if (typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) {
      collectStringUrls(v, maxDepth, depth + 1, acc);
    }
  }
  return acc;
}

function isApiUrl(url: string) {
  return /\/api\/v\d+\//i.test(url) || /\/api\//i.test(url);
}

function isLikelySigningUrl(url: string) {
  if (/^\/notarial\/widget\/signatures\//i.test(url)) return true;
  if (!/^https?:\/\//i.test(url)) return false;
  if (isApiUrl(url)) return false;
  return /clicksign\.com/i.test(url);
}

function normalizeSigningUrl(url: string) {
  if (!url) return "";
  if (/^https?:\/\//i.test(url)) return url;
  if (/^\/notarial\/widget\/signatures\//i.test(url)) {
    return `${clicksignAppOrigin()}${url}`;
  }
  return "";
}

function pickEmbeddedSignerKey(result: Record<string, unknown>) {
  const data = (result?.data || null) as Record<string, unknown> | null;
  const attrs = (data?.attributes || {}) as Record<string, unknown>;
  const candidates = [
    attrs.key,
    attrs.signer_key,
    attrs.signature_key,
    attrs.request_signature_key,
    data?.id
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }
  return "";
}

function pickSigningUrl(result: Record<string, unknown>) {
  const data = (result?.data || null) as Record<string, unknown> | null;
  const attrs = (data?.attributes || {}) as Record<string, unknown>;
  const links = (result?.links || {}) as Record<string, unknown>;
  const dataLinks = (data?.links || {}) as Record<string, unknown>;

  const prioritized = [
    attrs.sign_url,
    attrs.signature_url,
    attrs.url,
    dataLinks.sign,
    dataLinks.signature,
    links.sign,
    links.signature
  ];
  for (const candidate of prioritized) {
    if (typeof candidate === "string" && isLikelySigningUrl(candidate)) {
      const normalized = normalizeSigningUrl(candidate);
      if (normalized) return normalized;
    }
  }

  const allUrls = collectStringUrls(result).filter(isLikelySigningUrl);
  const preferredRaw =
    allUrls.find((url) => /\/sign(\/|$|\?)/i.test(url)) ||
    allUrls.find((url) => /\/notarial\/widget\/signatures\//i.test(url)) ||
    allUrls.find((url) => /sandbox\.clicksign\.com|clicksign\.com/i.test(url)) ||
    "";
  return normalizeSigningUrl(preferredRaw);
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ ok: false, error: "Método não permitido." }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }

  try {
    const body = (await req.json()) as RequestPayload;
    if (!body.request_id) {
      return new Response(JSON.stringify({ ok: false, error: "request_id é obrigatório." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    const role = body.role === "admin" ? "admin" : "secretaria";
    const supabase = adminClient();

    const { data: requestRow, error: requestError } = await supabase
      .from("lp_document_requests")
      .select("*")
      .eq("id", body.request_id)
      .single();

    if (requestError || !requestRow) {
      throw new Error(`Pedido não encontrado: ${requestError?.message || body.request_id}`);
    }

    if (!requestRow.clicksign_envelope_id || !requestRow.clicksign_document_id) {
      throw new Error("Envelope Clicksign não configurado para este pedido.");
    }

    const signerId = role === "admin"
      ? requestRow.clicksign_signer_admin_id
      : requestRow.clicksign_signer_secretaria_id;

    if (!signerId) {
      throw new Error(`Signatário Clicksign (${role}) não encontrado para este pedido.`);
    }

    const envelopeId = String(requestRow.clicksign_envelope_id);
    const signerDetails = await clicksignRequest(`/envelopes/${envelopeId}/signers/${signerId}`, "GET");
    let signingUrl = pickSigningUrl(signerDetails);
    let embeddedSignerKey = pickEmbeddedSignerKey(signerDetails);
    let signersList: Record<string, unknown> | null = null;

    if (!signingUrl) {
      signersList = await clicksignRequest(`/envelopes/${envelopeId}/signers`, "GET");
      signingUrl = pickSigningUrl(signersList);
      if (!embeddedSignerKey) {
        const listData = (signersList?.data || []) as Array<Record<string, unknown>>;
        const matchedSigner = listData.find((item) => String(item?.id || "") === String(signerId));
        if (matchedSigner) {
          embeddedSignerKey =
            pickEmbeddedSignerKey({ data: matchedSigner }) ||
            embeddedSignerKey;
        }
      }
    }

    if (!signingUrl && !embeddedSignerKey) {
      // Fallback operacional: algumas contas retornam apenas o signer id.
      embeddedSignerKey = String(signerId);
      signingUrl = `${clicksignAppOrigin()}/notarial/widget/signatures/${encodeURIComponent(String(signerId))}`;
    }

    await supabase.from("lp_request_status_history").insert({
      request_id: requestRow.id,
      protocol: requestRow.protocol,
      old_status: requestRow.status,
      new_status: requestRow.status,
      changed_by: "clicksign_signature_request",
      changed_by_email: role === "admin"
        ? (Deno.env.get("CLICKSIGN_SIGNER_ADMIN_EMAIL") || "diretor@einsteinhub.co")
        : (Deno.env.get("CLICKSIGN_SIGNER_SECRETARIA_EMAIL") || "secretaria@einsteinhub.co"),
      notes: `Solicitação de assinatura Clicksign disparada para ${role}.`,
      metadata: {
        clicksign_envelope_id: envelopeId,
        clicksign_signer_id: signerId,
        signing_url_returned: Boolean(signingUrl),
        embedded_signer_key_returned: Boolean(embeddedSignerKey)
      }
    });

    return new Response(JSON.stringify({
      ok: true,
      signing_url: signingUrl || null,
      embedded_signer_key: embeddedSignerKey || null
    }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Falha desconhecida.";
    return new Response(JSON.stringify({ ok: false, error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
});
