import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
};

function adminClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY não configurados.");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function sendReadyNotification(requestRow: Record<string, unknown>) {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  if (!supabaseUrl) return;
  const recipients = Array.from(new Set([
    "diretor@einsteinhub.co",
    "secretaria@einsteinhub.co",
    String(requestRow.requester_email || "").toLowerCase()
  ].filter(Boolean)));

  const response = await fetch(`${supabaseUrl}/functions/v1/send-workflow-email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
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
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Falha ao notificar documento_pronto: HTTP ${response.status} ${body}`);
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabase = adminClient();
    if (req.method === "GET") {
      const { data, error } = await supabase
        .from("lp_document_requests")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(1000);

      if (error) throw new Error(error.message);

      const rows = data || [];
      const counts: Record<string, number> = {};
      for (const row of rows) {
        const key = String(row.status || "unknown");
        counts[key] = (counts[key] || 0) + 1;
      }

      return new Response(JSON.stringify({
        ok: true,
        total_rows: rows.length,
        status_counts: counts,
        rows,
        latest_rows: rows.slice(0, 10)
      }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    if (req.method === "POST") {
      const body = await req.json() as {
        action?: string;
        request_id?: string;
        role?: "admin" | "secretaria";
        new_status?: string;
        transition_options?: Record<string, unknown>;
      };
      if (!body.action || !body.request_id) {
        return new Response(JSON.stringify({ ok: false, error: "Payload inválido." }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      const { data: row, error: rowError } = await supabase
        .from("lp_document_requests")
        .select("*")
        .eq("id", body.request_id)
        .single();
      if (rowError || !row) throw new Error(`Pedido não encontrado: ${rowError?.message || body.request_id}`);

      if (body.action === "mark_signature") {
        if (!body.role) {
          return new Response(JSON.stringify({ ok: false, error: "role é obrigatório para mark_signature." }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }
        const updateData: Record<string, unknown> = {};
        if (body.role === "admin") {
          updateData.signed_by_admin = true;
          updateData.clicksign_signed_admin_at = new Date().toISOString();
        }
        if (body.role === "secretaria") {
          updateData.signed_by_secretaria = true;
          updateData.clicksign_signed_secretaria_at = new Date().toISOString();
        }
        updateData.clicksign_last_event = "sign";

        const signedByAdmin = Boolean(updateData.signed_by_admin ?? row.signed_by_admin);
        const signedBySecretaria = Boolean(updateData.signed_by_secretaria ?? row.signed_by_secretaria);
        const bothSigned = signedByAdmin && signedBySecretaria;
        if (bothSigned && String(row.status) === "assinaturas_pendentes") {
          updateData.status = "documento_pronto";
          updateData.signed_at = new Date().toISOString();
          updateData.clicksign_status = "completed";
        }

        const { data: updatedRow, error: updateError } = await supabase
          .from("lp_document_requests")
          .update(updateData)
          .eq("id", body.request_id)
          .select("*")
          .single();
        if (updateError || !updatedRow) throw new Error(updateError?.message || "Falha ao atualizar assinatura.");

        await supabase.from("lp_request_status_history").insert({
          request_id: updatedRow.id,
          protocol: updatedRow.protocol,
          old_status: row.status,
          new_status: updatedRow.status,
          changed_by: body.role === "admin" ? "diretor" : "secretaria",
          changed_by_email: body.role === "admin" ? "diretor@einsteinhub.co" : "secretaria@einsteinhub.co",
          notes: bothSigned
            ? "Assinaturas de diretor e secretaria concluídas. Documento pronto."
            : `Assinatura confirmada para ${body.role === "admin" ? "diretor" : "secretaria"}.`,
          metadata: { source: "admin_diagnostic_requests", role: body.role }
        });

        if (bothSigned && String(row.status) === "assinaturas_pendentes") {
          try {
            await sendReadyNotification(updatedRow as Record<string, unknown>);
          } catch (notifyError) {
            console.error("Falha ao enviar notificação documento_pronto:", notifyError);
          }
        }

        return new Response(JSON.stringify({ ok: true, request: updatedRow }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      if (body.action === "transition_status") {
        if (!body.new_status) {
          return new Response(JSON.stringify({ ok: false, error: "new_status é obrigatório para transition_status." }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }

        const options = body.transition_options || {};
        const updateData: Record<string, unknown> = { status: body.new_status };
        if (options.producingStartedAt) updateData.producing_started_at = options.producingStartedAt;
        if (options.productionReadyAt) updateData.production_ready_at = options.productionReadyAt;
        if (options.signedAt) updateData.signed_at = options.signedAt;
        if (options.digitalSentAt) updateData.digital_sent_at = options.digitalSentAt;
        if (options.physicalReadyAt) updateData.physical_ready_at = options.physicalReadyAt;
        if (typeof options.signedByAdmin === "boolean") updateData.signed_by_admin = options.signedByAdmin;
        if (typeof options.signedBySecretaria === "boolean") updateData.signed_by_secretaria = options.signedBySecretaria;

        const { data: updatedRow, error: updateError } = await supabase
          .from("lp_document_requests")
          .update(updateData)
          .eq("id", body.request_id)
          .select("*")
          .single();
        if (updateError || !updatedRow) throw new Error(updateError?.message || "Falha ao atualizar status.");

        await supabase.from("lp_request_status_history").insert({
          request_id: updatedRow.id,
          protocol: updatedRow.protocol,
          old_status: row.status,
          new_status: body.new_status,
          changed_by: "admin_service_role",
          changed_by_email: null,
          notes: String(options.historyNote || `Transição para ${body.new_status} via função administrativa.`),
          metadata: options.historyMetadata || {}
        });

        return new Response(JSON.stringify({ ok: true, request: updatedRow }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      return new Response(JSON.stringify({ ok: false, error: `Ação não suportada: ${body.action}` }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    return new Response(JSON.stringify({ ok: false, error: "Método não permitido." }), {
      status: 405,
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

