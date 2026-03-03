import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import nodemailer from "npm:nodemailer@6.9.16";

type WorkflowPayload = {
  event_type?: string;
  request_id?: string;
  protocol?: string;
  document_label?: string;
  prazo?: string;
  user_name?: string;
  user_email?: string;
  profile?: string;
  status?: string;
  destination_emails?: string[];
  id_document_path?: string;
  document_download_url?: string;
  force_refresh_signed_document?: boolean;
};

function clicksignBaseUrl() {
  return (Deno.env.get("CLICKSIGN_BASE_URL") || "https://sandbox.clicksign.com/api/v3").replace(/\/+$/, "");
}

function clicksignAuthHeaders() {
  const rawToken = (Deno.env.get("CLICKSIGN_ACCESS_TOKEN") || "").trim();
  if (!rawToken) return [];
  return /^Bearer\s+/i.test(rawToken) ? [rawToken] : [rawToken, `Bearer ${rawToken}`];
}

async function clicksignRequest(path: string) {
  const authHeaders = clicksignAuthHeaders();
  if (!authHeaders.length) return {};
  let lastStatus = 0;
  let lastParsed: unknown = {};
  for (const authorization of authHeaders) {
    const response = await fetch(`${clicksignBaseUrl()}${path}`, {
      method: "GET",
      headers: {
        Authorization: authorization,
        Accept: "application/vnd.api+json",
        "Content-Type": "application/vnd.api+json"
      }
    });
    const text = await response.text();
    const parsed = text ? (() => { try { return JSON.parse(text); } catch { return { raw: text }; } })() : {};
    if (response.ok) return parsed as Record<string, unknown>;
    lastStatus = response.status;
    lastParsed = parsed;
    if (response.status !== 401) break;
  }
  console.error(`Clicksign GET ${path} falhou`, lastStatus, lastParsed);
  return {};
}

function collectStringUrls(value: unknown, maxDepth = 6, depth = 0, acc: string[] = []) {
  if (depth > maxDepth || value == null) return acc;
  if (typeof value === "string") {
    if (value.startsWith("http://") || value.startsWith("https://")) acc.push(value);
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

function isLikelyDocumentDownloadUrl(url: string) {
  if (!/^https?:\/\//i.test(url)) return false;
  if (/\/api\/v\d+\//i.test(url)) return false;
  return (
    /\.(pdf|zip)(\?|$)/i.test(url) ||
    /amazonaws\.com|storage\.googleapis\.com|clicksign/i.test(url)
  );
}

function pickSignedUrlFromDocumentNode(docNode: Record<string, unknown>) {
  const links = (docNode.links || {}) as Record<string, unknown>;
  const files = (links.files || {}) as Record<string, unknown>;
  const signed = typeof files.signed === "string" ? files.signed : "";
  const ziped = typeof files.ziped === "string" ? files.ziped : "";
  const original = typeof files.original === "string" ? files.original : "";
  if (signed && isLikelyDocumentDownloadUrl(signed)) return signed;
  if (ziped && isLikelyDocumentDownloadUrl(ziped)) return ziped;
  if (original && isLikelyDocumentDownloadUrl(original)) return original;
  return "";
}

async function resolveClicksignSignedDocumentUrl(envelopeId: string, documentId: string) {
  const prioritized: string[] = [];
  const fallbackCandidates: string[] = [];
  const details = await clicksignRequest(`/envelopes/${envelopeId}/documents/${documentId}`);
  const detailsData = ((details as Record<string, unknown>)?.data || {}) as Record<string, unknown>;
  const detailsSigned = pickSignedUrlFromDocumentNode(detailsData);
  if (detailsSigned) prioritized.push(detailsSigned);
  fallbackCandidates.push(...collectStringUrls(details).filter(isLikelyDocumentDownloadUrl));

  if (!prioritized.length) {
    const listing = await clicksignRequest(`/envelopes/${envelopeId}/documents`);
    const rows = Array.isArray((listing as Record<string, unknown>)?.data)
      ? (listing as { data: Array<Record<string, unknown>> }).data
      : [];
    const matched = rows.find((row) => String(row?.id || "") === String(documentId));
    if (matched) {
      const matchedSigned = pickSignedUrlFromDocumentNode(matched);
      if (matchedSigned) prioritized.push(matchedSigned);
      fallbackCandidates.push(...collectStringUrls(matched).filter(isLikelyDocumentDownloadUrl));
    }
    fallbackCandidates.push(...collectStringUrls(listing).filter(isLikelyDocumentDownloadUrl));
  }

  return prioritized[0] || fallbackCandidates[0] || "";
}

type EmailLogInsert = {
  protocol: string;
  request_id?: string | null;
  event_type: string;
  recipient_email: string;
  provider: string;
  provider_message_id?: string | null;
  status: "success" | "error";
  error_message?: string | null;
  payload: Record<string, unknown>;
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

function normalizeProfile(value: string | undefined) {
  return (value || "aluno").replace("_", "-");
}

function timelineHtmlByEvent(eventType: string) {
  const steps = [
    "Requerimento de Documento",
    "Envio de Documento de Identificação",
    "Requerimento em Análise",
    "Documento em Produção",
    "Documento Pronto",
    "Documento Digital Enviado por E-mail",
    "Documento Físico Disponível na Secretaria"
  ];

  const activeIndexByEvent: Record<string, number> = {
    novo_requerimento: 2,
    requerimento_em_analise: 2,
    novo_requerimento_usuario: 2,
    documento_em_producao: 3,
    assinaturas_pendentes: 4,
    documento_pronto: 4,
    documento_digital_enviado_email: 5,
    documento_fisico_disponivel_secretaria: 6
  };

  const activeIndex = activeIndexByEvent[eventType];

  return `<ol style="padding:0; margin:0; list-style:none;">
    ${steps
      .map((step, index) => {
        const forceDoneForDigitalEmail =
          eventType === "documento_digital_enviado_email" && index === 5;
        const forceDoneForPhysicalEmail =
          eventType === "documento_fisico_disponivel_secretaria" && index === 6;
        const forcedDone = forceDoneForDigitalEmail || forceDoneForPhysicalEmail;
        const isDone = index < activeIndex || forcedDone;
        const isActive = index === activeIndex && !forcedDone;
        const bg = isActive ? "#e9a92d" : isDone ? "#2da969" : "#38476f";
        const color = isActive ? "#fff1bf" : isDone ? "#ffe6a1" : "#ffd977";
        return `
          <li style="display:flex; gap:10px; align-items:flex-start; margin:8px 0;">
            <span style="display:inline-block; width:12px; height:12px; border-radius:99px; background:${bg}; margin-top:4px;"></span>
            <span style="color:${color}; font-size:14px;">${step}</span>
          </li>
        `;
      })
      .join("")}
  </ol>`;
}

function buildTemplate(eventType: string, payload: WorkflowPayload) {
  const protocol = payload.protocol || "não informado";
  const documentLabel = payload.document_label || "Documento não informado";
  const prazo = payload.prazo || "a definir";
  const userName = payload.user_name || "Usuário";
  const profile = normalizeProfile(payload.profile);
  const documentDownloadUrl = payload.document_download_url || "";

  const eventTitleByType: Record<string, string> = {
    novo_requerimento: "Novo requerimento recebido para análise",
    requerimento_em_analise: "Seu requerimento está em análise",
    novo_requerimento_usuario: "Seu requerimento foi recebido com sucesso",
    documento_em_producao: "Seu documento entrou em produção",
    assinaturas_pendentes: "Seu documento está em fase de assinaturas",
    documento_pronto: "Seu documento está pronto",
    documento_digital_enviado_email: "Seu documento digital foi enviado",
    documento_fisico_disponivel_secretaria: "Seu documento físico está disponível na secretaria"
  };

  const eventDescriptionByType: Record<string, string> = {
    novo_requerimento:
      "Um novo requerimento com documento oficial foi enviado. A secretaria deve validar identidade e tipo de via.",
    requerimento_em_analise:
      "Recebemos seu requerimento com documento oficial. A secretaria está analisando identidade e tipo de via.",
    novo_requerimento_usuario:
      "Recebemos seu requerimento com documento oficial. A secretaria irá validar identidade e tipo de via antes de iniciar a produção.",
    documento_em_producao:
      "A secretaria confirmou sua identidade. Seu requerimento foi aprovado e está em produção.",
    assinaturas_pendentes:
      "Seu documento foi produzido e entrou na etapa de assinaturas administrativas.",
    documento_pronto:
      "Seu documento foi finalizado e está pronto para envio digital/etapa final.",
    documento_digital_enviado_email:
      "O documento foi assinado digitalmente por diretor e secretaria e está sendo enviado para seu e-mail.",
    documento_fisico_disponivel_secretaria:
      "A secretaria confirmou a disponibilidade do documento físico para retirada."
  };

  const title = eventTitleByType[eventType] || "Atualização do status do seu requerimento";
  const description = eventDescriptionByType[eventType] || "Houve uma atualização no seu requerimento.";

  const subject = `[DOC-Einstein] ${title} | Protocolo ${protocol}`;

  const downloadSection = documentDownloadUrl
    ? `
      <div style="margin:14px 0; padding:12px; border-radius:12px; border:1px solid rgba(45,169,105,.45); background:rgba(45,169,105,.12);">
        <p style="margin:0 0 10px; color:#c9ffd9;"><strong>Download do documento assinado</strong></p>
        <a href="${documentDownloadUrl}" target="_blank" rel="noopener noreferrer" style="display:inline-block; padding:10px 14px; border-radius:10px; background:#2da969; color:#fff; text-decoration:none; font-weight:700;">
          Baixar documento final (PDF)
        </a>
        <p style="margin:8px 0 0; color:#b7caef; font-size:12px;">O link pode expirar por segurança. Se expirar, solicite novo envio no painel administrativo.</p>
      </div>`
    : "";

  const html = `
  <div style="margin:0; padding:24px; background:#060f2f; color:#f1f6ff; font-family:Arial, sans-serif;">
    <div style="max-width:680px; margin:0 auto; border:1px solid rgba(164,190,255,.32); border-radius:16px; background:linear-gradient(180deg, #0a1c53, #08133b); padding:20px;">
      <h1 style="margin:0 0 6px; font-size:22px;">DOC-Einstein</h1>
      <p style="margin:0 0 14px; color:#c4d6ff;">${title}</p>
      <p style="margin:0 0 14px; color:#d7e4ff;">${description}</p>
      <div style="border:1px solid rgba(255,216,112,.38); border-radius:12px; padding:12px; margin-bottom:14px; background:rgba(255,216,112,.1); color:#ffe6a8;">
        <div><strong>Protocolo:</strong> ${protocol}</div>
        <div><strong>Perfil:</strong> ${profile}</div>
        <div><strong>Documento:</strong> ${documentLabel}</div>
        <div><strong>Prazo de referência:</strong> ${prazo}</div>
      </div>
      ${downloadSection}
      <h2 style="margin:0 0 8px; font-size:17px;">Linha do tempo</h2>
      ${timelineHtmlByEvent(eventType)}
      <p style="margin:16px 0 0; color:#b7caef;">Atenciosamente,<br />Secretaria do Colégio Einstein</p>
    </div>
    <p style="max-width:680px; margin:10px auto 0; font-size:12px; color:#8fa6da;">
      Mensagem automática do workflow DOC-Einstein para ${userName}.
    </p>
  </div>`;

  const text = [
    "DOC-Einstein",
    title,
    description,
    `Protocolo: ${protocol}`,
    `Perfil: ${profile}`,
    `Documento: ${documentLabel}`,
    `Prazo: ${prazo}`,
    documentDownloadUrl ? `Download do documento: ${documentDownloadUrl}` : null
  ].filter(Boolean).join("\n");

  return { subject, html, text };
}

async function enrichPayloadWithDownloadUrl(payload: WorkflowPayload) {
  if (payload.event_type !== "documento_digital_enviado_email") return payload;
  if (payload.document_download_url) return payload;
  if (!payload.request_id) return payload;

  const adminClient = buildAdminClient();
  if (!adminClient) return payload;

  const { data: requestRow, error: requestError } = await adminClient
    .from("lp_document_requests")
    .select("payload, clicksign_envelope_id, clicksign_document_id, protocol")
    .eq("id", payload.request_id)
    .maybeSingle();
  if (requestError || !requestRow) return payload;

  const requestPayload = ((requestRow as Record<string, unknown>)?.payload || {}) as Record<string, unknown>;
  const clicksignMeta = (requestPayload.clicksign || {}) as Record<string, unknown>;
  let producedPath = typeof requestPayload.produced_document_path === "string"
    ? requestPayload.produced_document_path
    : "";

  const shouldForceRefresh = Boolean(payload.force_refresh_signed_document);
  const cachedSignedPath = typeof clicksignMeta.signed_document_path === "string"
    ? clicksignMeta.signed_document_path
    : "";

  if (cachedSignedPath && !shouldForceRefresh) {
    producedPath = cachedSignedPath;
  } else {
    const envelopeId = String((requestRow as Record<string, unknown>).clicksign_envelope_id || "");
    const documentId = String((requestRow as Record<string, unknown>).clicksign_document_id || "");
    if (envelopeId && documentId) {
      const clicksignFileUrl = await resolveClicksignSignedDocumentUrl(envelopeId, documentId);
      if (clicksignFileUrl) {
        try {
          const fileResponse = await fetch(clicksignFileUrl);
          if (fileResponse.ok) {
            const bytes = new Uint8Array(await fileResponse.arrayBuffer());
            const protocol = String((requestRow as Record<string, unknown>).protocol || "documento");
            const signedPath = `produzidos-assinados/${payload.request_id}/${Date.now()}-${protocol}-assinado.pdf`;
            const uploadResult = await adminClient.storage
              .from("id_autorizacao_enviados")
              .upload(signedPath, bytes, {
                upsert: true,
                contentType: "application/pdf"
              });
            if (!uploadResult.error) {
              producedPath = signedPath;
              const nextPayload = {
                ...requestPayload,
                clicksign: {
                  ...clicksignMeta,
                  signed_document_path: signedPath,
                  signed_document_source_url: clicksignFileUrl,
                  signed_document_fetched_at: new Date().toISOString()
                }
              };
              await adminClient
                .from("lp_document_requests")
                .update({ payload: nextPayload })
                .eq("id", payload.request_id);
            }
          }
        } catch (error) {
          console.error("Falha ao obter documento assinado da Clicksign:", error);
        }
      }
    }
  }

  if (!producedPath) return payload;

  const signedUrlResult = await adminClient.storage
    .from("id_autorizacao_enviados")
    .createSignedUrl(producedPath, 60 * 60 * 24 * 3);
  if (signedUrlResult.error || !signedUrlResult.data?.signedUrl) return payload;

  return {
    ...payload,
    document_download_url: signedUrlResult.data.signedUrl
  };
}

async function sendSmtpEmail(
  smtpHost: string,
  smtpPort: number,
  smtpUser: string,
  smtpPass: string,
  fromEmail: string,
  toEmails: string[],
  subject: string,
  html: string,
  text: string
) {
  const transporter = nodemailer.createTransport({
    host: smtpHost,
    port: smtpPort,
    secure: smtpPort === 465,
    auth: {
      user: smtpUser,
      pass: smtpPass
    }
  });

  const responseInfo = await transporter.sendMail({
    from: fromEmail,
    to: toEmails.join(","),
    subject,
    html,
    text
  });

  return {
    provider: "smtp",
    providerMessageId: responseInfo?.messageId || null
  };
}

function buildAdminClient() {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) return null;
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
}

async function insertEmailLogs(logs: EmailLogInsert[]) {
  const adminClient = buildAdminClient();
  if (!adminClient || !logs.length) return [];

  const { data, error } = await adminClient
    .from("lp_email_event_logs")
    .insert(logs)
    .select("id");

  if (error) {
    console.error("Falha ao registrar lp_email_event_logs:", error.message);
    return [];
  }

  return (data || []).map((row) => row.id);
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
    const rawPayload = (await req.json()) as WorkflowPayload;
    const payload = await enrichPayloadWithDownloadUrl(rawPayload);
    const eventType = payload.event_type;
    if (!eventType) {
      return new Response(JSON.stringify({ error: "event_type é obrigatório." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    const smtpHost = Deno.env.get("SMTP_HOST");
    const smtpPortRaw = Deno.env.get("SMTP_PORT");
    const smtpUser = Deno.env.get("SMTP_USER");
    const smtpPass = Deno.env.get("SMTP_PASS");
    const smtpPort = Number(smtpPortRaw || "587");
    const fromEmail = Deno.env.get("FROM_EMAIL") || "nao-responder@einsteinhub.co";
    const adminEmailsFromEnv = (Deno.env.get("ADMIN_NOTIFICATION_EMAILS") || "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);

    if (!smtpHost || !smtpUser || !smtpPass || !Number.isFinite(smtpPort)) {
      return new Response(JSON.stringify({ error: "SMTP não configurado corretamente (SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS)." }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    const defaultAdminEmails = [
      "diretor@einsteinhub.co",
      "secretaria@einsteinhub.co"
    ];
    const destinationEmails = (payload.destination_emails || [])
      .map((value) => String(value || "").trim().toLowerCase())
      .filter(Boolean);
    const isAdminNotificationEvent = eventType === "novo_requerimento";
    const toEmails =
      destinationEmails.length
        ? destinationEmails
        : isAdminNotificationEvent
          ? (adminEmailsFromEnv.length ? adminEmailsFromEnv : defaultAdminEmails)
          : payload.user_email
            ? [payload.user_email]
            : [];

    if (!toEmails.length) {
      return new Response(JSON.stringify({ error: "Nenhum destinatário válido para este evento." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    const { subject, html, text } = buildTemplate(eventType, payload);
    const providerResult = await sendSmtpEmail(
      smtpHost,
      smtpPort,
      smtpUser,
      smtpPass,
      fromEmail,
      toEmails,
      subject,
      html,
      text
    );

    const successLogs: EmailLogInsert[] = toEmails.map((recipientEmail) => ({
      protocol: payload.protocol || "nao_informado",
      request_id: payload.request_id || null,
      event_type: eventType,
      recipient_email: recipientEmail,
      provider: providerResult.provider,
      provider_message_id: providerResult.providerMessageId,
      status: "success",
      error_message: null,
      payload: payload as Record<string, unknown>
    }));
    const insertedLogIds = await insertEmailLogs(successLogs);

    return new Response(
      JSON.stringify({
        ok: true,
        event_type: eventType,
        to: toEmails,
        log_ids: insertedLogIds
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Falha desconhecida.";
    try {
      const fallbackPayload = (await req.clone().json()) as WorkflowPayload;
      const fallbackEventType = fallbackPayload.event_type || "evento_desconhecido";
      const fallbackRecipients = fallbackPayload.destination_emails?.length
        ? fallbackPayload.destination_emails
        : fallbackPayload.user_email
          ? [fallbackPayload.user_email]
          : ["destinatario_nao_informado"];
      const errorLogs: EmailLogInsert[] = fallbackRecipients.map((recipientEmail) => ({
        protocol: fallbackPayload.protocol || "nao_informado",
        request_id: fallbackPayload.request_id || null,
        event_type: fallbackEventType,
        recipient_email: recipientEmail,
        provider: "smtp",
        provider_message_id: null,
        status: "error",
        error_message: message,
        payload: fallbackPayload as Record<string, unknown>
      }));
      await insertEmailLogs(errorLogs);
    } catch (_loggingError) {
      console.error("Falha ao registrar erro em lp_email_event_logs.");
    }

    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
});
