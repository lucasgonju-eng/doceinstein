(function () {
  const SUPABASE_URL = "https://ijyuinzducrtgerupcyk.supabase.co";
  const SUPABASE_ANON_KEY = "sb_publishable_CQADd4bRX_ZCEZkGaYNiMg_a3vlohsO";
  const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const DIRECTOR_EMAIL = "diretor@einsteinhub.co";
  const SECRETARIA_EMAIL = "secretaria@einsteinhub.co";

  const ADMIN_EMAILS = new Set([
    DIRECTOR_EMAIL,
    SECRETARIA_EMAIL
  ]);

  const statusMsg = document.getElementById("adminStatusMsg");
  const adminIdentityChip = document.getElementById("adminIdentityChip");
  const btnAtualizarAdmin = document.getElementById("btnAtualizarAdmin");
  const btnSairAdmin = document.getElementById("btnSairAdmin");
  const tabButtons = Array.from(document.querySelectorAll(".stitch-admin-tab"));
  const tabPanels = Array.from(document.querySelectorAll(".stitch-admin-panel"));
  const pedidosList = document.getElementById("pedidosList");
  const producaoList = document.getElementById("producaoList");
  const assinaturasList = document.getElementById("assinaturasList");
  const prontoList = document.getElementById("prontoList");
  const fisicosList = document.getElementById("fisicosList");

  const requestsById = new Map();
  let adminUser = null;

  function setStatus(message, type) {
    if (!statusMsg) return;
    statusMsg.textContent = message;
    statusMsg.classList.remove("ok", "error");
    if (type) statusMsg.classList.add(type);
  }

  function debugLog(_step, _payload) {
    // Debug visual removido para produção.
  }

  function adminLoginUrl() {
    return "login.html?modo=login&redirect=admin-dashboard.html";
  }

  function stripFreshAdminLoginParam() {
    const current = new URL(window.location.href);
    if (!current.searchParams.has("fresh_admin_login")) return;
    current.searchParams.delete("fresh_admin_login");
    const nextUrl = current.pathname + (current.search ? current.search : "");
    window.history.replaceState({}, "", nextUrl);
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function statusLabel(status) {
    const map = {
      requerimento_em_analise: "Requerimento em análise",
      documento_em_producao: "Documento em produção",
      assinaturas_pendentes: "Assinaturas pendentes",
      documento_pronto: "Documento pronto",
      documento_digital_enviado_email: "Documento digital enviado por e-mail",
      documento_fisico_disponivel_secretaria: "Documento físico disponível na secretaria"
    };
    return map[status] || status;
  }

  function documentLabel(requestRow) {
    if (requestRow.document_type === "declaracao_transferencia") return "Declaração de Transferência";
    if (requestRow.document_type === "declaracao_frequencia") return "Declaração de Frequência";
    if (requestRow.document_type === "historico_certificado") return "Histórico Escolar + Certificado";
    if (requestRow.document_type === "outros") return requestRow.document_other || "Outros";
    return requestRow.document_other || requestRow.document_type || "Documento não informado";
  }

  function formatDate(value) {
    if (!value) return "n/d";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "n/d";
    return date.toLocaleString("pt-BR");
  }

  function adminRoleByEmail(email) {
    if (email === DIRECTOR_EMAIL) return "admin";
    return "secretaria";
  }

  function currentOperatorRole() {
    return adminRoleByEmail((adminUser?.email || "").toLowerCase());
  }

  function currentOperatorEmail() {
    return (adminUser?.email || "").toLowerCase();
  }

  function currentOperatorLabel() {
    return currentOperatorRole() === "admin" ? "diretor (Lucas Júnior)" : "secretaria (Kathia)";
  }

  function setButtonLoading(button, loading, loadingText) {
    if (!button) return;
    if (loading) {
      button.dataset.originalText = button.textContent;
      button.textContent = loadingText;
      button.disabled = true;
      return;
    }
    button.textContent = button.dataset.originalText || button.textContent;
    button.disabled = false;
  }

  async function functionAuthHeaders() {
    const { data } = await supabaseClient.auth.getSession();
    const accessToken = data?.session?.access_token || "";
    const headers = {
      "Content-Type": "application/json",
      apikey: SUPABASE_ANON_KEY
    };
    if (accessToken) {
      headers.Authorization = `Bearer ${accessToken}`;
    }
    return headers;
  }

  async function sendWorkflowEmail(payload) {
    try {
      const headers = await functionAuthHeaders();
      const response = await fetch(`${SUPABASE_URL}/functions/v1/send-workflow-email`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload)
      });
      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorBody}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Falha desconhecida no envio de e-mail.";
      console.warn("Erro de rede ao enviar e-mail do workflow:", message);
      setStatus(`Aviso: atualização de e-mail não enviada (${message}).`, "error");
    }
  }

  async function logHistory(requestRow, oldStatus, newStatus, notes, metadata) {
    const changedByEmail = (adminUser?.email || "").toLowerCase();
    const changedBy = adminRoleByEmail(changedByEmail);

    const historyRow = {
      request_id: requestRow.id,
      protocol: requestRow.protocol,
      old_status: oldStatus,
      new_status: newStatus,
      changed_by: changedBy,
      changed_by_email: changedByEmail,
      notes: notes || null,
      metadata: metadata || {}
    };

    const { error } = await supabaseClient.from("lp_request_status_history").insert(historyRow);
    if (error) {
      console.warn("Falha ao registrar histórico administrativo:", error.message);
    }
  }

  async function transitionRequestStatus(requestRow, newStatus, transitionOptions) {
    const options = transitionOptions || {};
    const updateData = {
      status: newStatus
    };

    if (options.producingStartedAt) updateData.producing_started_at = options.producingStartedAt;
    if (options.productionReadyAt) updateData.production_ready_at = options.productionReadyAt;
    if (options.signedAt) updateData.signed_at = options.signedAt;
    if (options.digitalSentAt) updateData.digital_sent_at = options.digitalSentAt;
    if (options.physicalReadyAt) updateData.physical_ready_at = options.physicalReadyAt;
    if (typeof options.signedByAdmin === "boolean") updateData.signed_by_admin = options.signedByAdmin;
    if (typeof options.signedBySecretaria === "boolean") updateData.signed_by_secretaria = options.signedBySecretaria;

    const { data, error } = await supabaseClient
      .from("lp_document_requests")
      .update(updateData)
      .eq("id", requestRow.id)
      .select("*")
      .single();

    if (error) {
      // Fallback service-role para contas admin sem RLS completo.
      const headers = await functionAuthHeaders();
      const fallbackResponse = await fetch(`${SUPABASE_URL}/functions/v1/admin-diagnostic-requests`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          action: "transition_status",
          request_id: requestRow.id,
          new_status: newStatus,
          transition_options: options
        })
      });
      const rawBody = await fallbackResponse.text();
      let parsedBody = {};
      try {
        parsedBody = rawBody ? JSON.parse(rawBody) : {};
      } catch {
        parsedBody = { raw: rawBody };
      }
      if (!fallbackResponse.ok || !parsedBody?.ok || !parsedBody?.request) {
        throw new Error(error.message);
      }
      requestsById.set(parsedBody.request.id, parsedBody.request);
      return parsedBody.request;
    }

    await logHistory(requestRow, requestRow.status, newStatus, options.historyNote, options.historyMetadata);
    requestsById.set(data.id, data);
    return data;
  }

  async function updateSignatureFlags(requestRow, signedByAdmin, signedBySecretaria) {
    const { data, error } = await supabaseClient
      .from("lp_document_requests")
      .update({
        signed_by_admin: signedByAdmin,
        signed_by_secretaria: signedBySecretaria
      })
      .eq("id", requestRow.id)
      .select("*")
      .single();

    if (error) {
      throw new Error(error.message);
    }

    await logHistory(
      requestRow,
      requestRow.status,
      requestRow.status,
      "Atualização manual de assinaturas pendentes.",
      {
        signed_by_admin: signedByAdmin,
        signed_by_secretaria: signedBySecretaria
      }
    );

    requestsById.set(data.id, data);
    return data;
  }

  async function openIdDocument(requestRow) {
    await openStorageDocument(
      requestRow.id_document_path,
      "Nenhum documento de identificação foi enviado para este pedido."
    );
  }

  async function openProducedDocument(requestRow) {
    const producedPath = requestRow.payload?.produced_document_path;
    await openStorageDocument(
      producedPath,
      "Nenhum documento final foi enviado na etapa de produção para este pedido."
    );
  }

  async function openStorageDocument(path, emptyMessage) {
    if (!path) {
      setStatus(emptyMessage, "error");
      return;
    }

    const { data, error } = await supabaseClient.storage
      .from("id_autorizacao_enviados")
      .createSignedUrl(path, 60 * 20);

    if (error || !data?.signedUrl) {
      setStatus(`Não foi possível abrir o documento: ${error?.message || "URL inválida"}`, "error");
      return;
    }

    window.open(data.signedUrl, "_blank", "noopener,noreferrer");
  }

  async function uploadProducedPdf(requestRow, file) {
    const safeName = (file.name || "documento.pdf").replace(/[^a-zA-Z0-9_.-]+/g, "-");
    const filePath = `produzidos/${requestRow.id}/${Date.now()}-${safeName}`;

    const { error } = await supabaseClient.storage
      .from("id_autorizacao_enviados")
      .upload(filePath, file, {
        upsert: false,
        contentType: file.type || "application/pdf"
      });

    if (error) {
      throw new Error(`Falha no upload do PDF: ${error.message}`);
    }

    return filePath;
  }

  async function startClicksignSignature(requestRow, producedPath, producedName) {
    const headers = await functionAuthHeaders();
    const response = await fetch(`${SUPABASE_URL}/functions/v1/clicksign-start-signature`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        request_id: requestRow.id,
        produced_document_path: producedPath,
        produced_document_name: producedName
      })
    });

    const rawBody = await response.text();
    let parsedBody = {};
    try {
      parsedBody = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      parsedBody = { raw: rawBody };
    }

    if (!response.ok) {
      throw new Error(`Falha ao iniciar Clicksign (HTTP ${response.status}): ${JSON.stringify(parsedBody)}`);
    }

    if (!parsedBody?.ok || !parsedBody?.request) {
      throw new Error(parsedBody?.error || "Falha desconhecida ao iniciar fluxo de assinatura.");
    }
    return parsedBody.request;
  }

  async function requestClicksignSignature(requestRow) {
    const operatorRole = currentOperatorRole();
    const headers = await functionAuthHeaders();
    debugLog("requestClicksignSignature: iniciando", {
      request_id: requestRow.id,
      role: operatorRole
    });
    const response = await fetch(`${SUPABASE_URL}/functions/v1/clicksign-request-signature`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        request_id: requestRow.id,
        role: operatorRole
      })
    });

    const rawBody = await response.text();
    let parsedBody = {};
    try {
      parsedBody = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      parsedBody = { raw: rawBody };
    }
    debugLog("requestClicksignSignature: retorno bruto", {
      http_status: response.status,
      body: parsedBody
    });

    if (!response.ok) {
      throw new Error(`Falha ao solicitar assinatura (HTTP ${response.status}): ${JSON.stringify(parsedBody)}`);
    }

    if (!parsedBody?.ok) {
      throw new Error(parsedBody?.error || "Falha desconhecida ao solicitar assinatura.");
    }
    return parsedBody;
  }

  async function findRequestById(requestId) {
    const fromCache = requestsById.get(requestId);
    if (fromCache) return fromCache;
    const { data, error } = await supabaseClient
      .from("lp_document_requests")
      .select("*")
      .eq("id", requestId)
      .single();
    if (error || !data) {
      throw new Error(`Pedido não encontrado para retorno de assinatura: ${error?.message || requestId}`);
    }
    requestsById.set(data.id, data);
    return data;
  }

  async function processClicksignReturn() {
    const params = new URLSearchParams(window.location.search);
    if (params.get("clicksign_signed") !== "1") return;

    const requestId = params.get("request_id") || "";
    const role = (params.get("role") || "").toLowerCase();
    if (!requestId || (role !== "admin" && role !== "secretaria")) return;
    const operatorEmail = currentOperatorEmail();
    if (role === "admin" && operatorEmail !== DIRECTOR_EMAIL) {
      setStatus("A assinatura de diretor só pode ser concluída pelo e-mail diretor@einsteinhub.co.", "error");
      return;
    }
    if (role === "secretaria" && operatorEmail !== SECRETARIA_EMAIL) {
      setStatus("A assinatura de secretaria só pode ser concluída pelo e-mail secretaria@einsteinhub.co.", "error");
      return;
    }

    debugLog("Retorno Clicksign detectado", { request_id: requestId, role });
    const headers = await functionAuthHeaders();
    const response = await fetch(`${SUPABASE_URL}/functions/v1/admin-diagnostic-requests`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        action: "mark_signature",
        request_id: requestId,
        role
      })
    });
    const raw = await response.text();
    let parsed = {};
    try {
      parsed = raw ? JSON.parse(raw) : {};
    } catch {
      parsed = { raw };
    }
    if (!response.ok || !parsed?.ok || !parsed?.request) {
      throw new Error(`Falha ao confirmar assinatura de retorno: HTTP ${response.status} ${JSON.stringify(parsed)}`);
    }
    const updatedRow = parsed.request;

    requestsById.set(updatedRow.id, updatedRow);
    await loadAdminRequests();
    setActiveTab("assinaturas");
    setStatus("Assinatura confirmada e status atualizado.", "ok");

    const cleanUrl = new URL(window.location.href);
    cleanUrl.searchParams.delete("clicksign_signed");
    cleanUrl.searchParams.delete("request_id");
    cleanUrl.searchParams.delete("role");
    const nextUrl = cleanUrl.pathname + (cleanUrl.search ? cleanUrl.search : "");
    window.history.replaceState({}, "", nextUrl);
  }

  function renderRequestCard(requestRow, mode) {
    const statusText = statusLabel(requestRow.status);
    const pedidoEm = formatDate(requestRow.created_at);
    const documento = documentLabel(requestRow);
    const reqEmail = requestRow.requester_email || "n/d";
    const reqNome = requestRow.requester_name || "n/d";
    const cpf = requestRow.cpf || "n/d";
    const rg = requestRow.rg || "n/d";
    const prazo = requestRow.payload?.prazo || "n/d";
    const profile = requestRow.form_type || "n/d";

    const openIdDocButton =
      `<button class="stitch-btn stitch-btn-ghost" type="button" data-action="open-id" data-request-id="${requestRow.id}">Abrir Documento Oficial de Identificação</button>`;
    const openFinalDocButton = requestRow.payload?.produced_document_path
      ? `<button class="stitch-btn stitch-btn-ghost" type="button" data-action="open-final" data-request-id="${requestRow.id}">Abrir documento FINAL</button>`
      : "";

    let actionButtons = "";
    if (mode === "pedidos") {
      if (requestRow.status === "requerimento_em_analise") {
        actionButtons =
          `<button class="stitch-btn stitch-btn-primary" type="button" data-action="approve-identity" data-request-id="${requestRow.id}">Confirmar identidade e iniciar produção</button>`;
      }
    }

    if (mode === "producao") {
      actionButtons =
        `<div class="stitch-field" style="width:100%;">
          <label for="pdfProducao-${requestRow.id}">Upload do documento produzido (PDF)</label>
          <input id="pdfProducao-${requestRow.id}" type="file" accept="application/pdf,.pdf" data-produced-file-input="${requestRow.id}" />
        </div>
        <button class="stitch-btn stitch-btn-primary" type="button" data-action="upload-and-move-signatures" data-request-id="${requestRow.id}">Subir PDF e enviar para Assinaturas Pendentes</button>`;
    }

    if (mode === "assinaturas") {
      const assinaturaDiretor = requestRow.signed_by_admin ? "Assinado" : "Pendente";
      const assinaturaSecretaria = requestRow.signed_by_secretaria ? "Assinado" : "Pendente";
      actionButtons =
        `<div class="stitch-admin-signature-grid">
          <p><strong>Diretor:</strong> ${assinaturaDiretor}</p>
          <p><strong>Secretaria:</strong> ${assinaturaSecretaria}</p>
          <p><strong>Clicksign:</strong> ${escapeHtml(requestRow.clicksign_status || "em andamento")}</p>
        </div>
        <button class="stitch-btn stitch-btn-primary" type="button" data-action="sign-clicksign" data-request-id="${requestRow.id}">Assinar como ${escapeHtml(currentOperatorLabel())}</button>
        <button class="stitch-btn stitch-btn-ghost" type="button" data-action="refresh-signature-status" data-request-id="${requestRow.id}">Atualizar status de assinaturas</button>`;
    }

    if (mode === "pronto") {
      const alreadySentDigital = requestRow.status === "documento_digital_enviado_email";
      actionButtons = alreadySentDigital
        ? `<button class="stitch-btn stitch-btn-primary" type="button" data-action="resend-digital-email" data-request-id="${requestRow.id}">Reenviar ao usuário</button>`
        : `<button class="stitch-btn stitch-btn-primary" type="button" data-action="release-digital-email" data-request-id="${requestRow.id}">Liberar envio ao usuário</button>`;
    }

    if (mode === "fisicos") {
      actionButtons =
        `<button class="stitch-btn stitch-btn-primary" type="button" data-action="mark-physical-ready" data-request-id="${requestRow.id}">Confirmar físico disponível na secretaria</button>`;
    }

    return (
      `<article class="stitch-admin-card" data-request-card="${requestRow.id}">
        <header class="stitch-admin-card-head">
          <strong>${escapeHtml(requestRow.protocol)}</strong>
          <span class="stitch-admin-status">${escapeHtml(statusText)}</span>
        </header>
        <p class="stitch-admin-meta"><strong>Nome:</strong> ${escapeHtml(reqNome)} • <strong>E-mail:</strong> ${escapeHtml(reqEmail)}</p>
        <p class="stitch-admin-meta"><strong>Perfil:</strong> ${escapeHtml(profile)} • <strong>Documento:</strong> ${escapeHtml(documento)}</p>
        <p class="stitch-admin-meta"><strong>CPF:</strong> ${escapeHtml(cpf)} • <strong>RG:</strong> ${escapeHtml(rg)}</p>
        <p class="stitch-admin-meta"><strong>Prazo:</strong> ${escapeHtml(prazo)} • <strong>Criado em:</strong> ${escapeHtml(pedidoEm)}</p>
        <div class="stitch-subpage-actions">
          ${openIdDocButton}
          ${openFinalDocButton}
          ${actionButtons}
        </div>
      </article>`
    );
  }

  function renderList(targetElement, rows, mode, emptyText) {
    if (!targetElement) return;
    if (!rows.length) {
      targetElement.innerHTML = `<p class="stitch-subpage-text">${escapeHtml(emptyText)}</p>`;
      return;
    }
    targetElement.innerHTML = rows.map((row) => renderRequestCard(row, mode)).join("");
  }

  async function loadAdminRequests() {
    setStatus("Carregando pedidos...", "");

    let { data, error } = await supabaseClient
      .from("lp_document_requests")
      .select("*")
      .order("created_at", { ascending: false });

    // Fallback para contas admin recém-criadas que ainda não receberam permissões RLS.
    if (error || !(data || []).length) {
      try {
        const headers = await functionAuthHeaders();
        const response = await fetch(`${SUPABASE_URL}/functions/v1/admin-diagnostic-requests`, {
          method: "GET",
          headers
        });
        const rawBody = await response.text();
        let parsedBody = {};
        try {
          parsedBody = rawBody ? JSON.parse(rawBody) : {};
        } catch {
          parsedBody = { raw: rawBody };
        }

        if (response.ok && parsedBody?.ok && Array.isArray(parsedBody?.rows)) {
          data = parsedBody.rows;
          error = null;
          debugLog("loadAdminRequests via service-role fallback", {
            total_rows: data.length,
            status_counts: parsedBody.status_counts || {}
          });
        }
      } catch (fallbackError) {
        debugLog("Falha no fallback service-role", {
          message: fallbackError?.message || String(fallbackError)
        });
      }
    }

    if (error) {
      setStatus(`Não foi possível carregar pedidos: ${error.message}`, "error");
      return;
    }

    requestsById.clear();
    (data || []).forEach((row) => requestsById.set(row.id, row));

    const pedidos = (data || []).filter((row) => row.status === "requerimento_em_analise");
    const producao = (data || []).filter((row) => row.status === "documento_em_producao");
    const assinaturas = (data || []).filter((row) => row.status === "assinaturas_pendentes");
    const pronto = (data || []).filter((row) =>
      row.status === "documento_pronto" || row.status === "documento_digital_enviado_email"
    );
    const fisicos = (data || []).filter((row) => row.status === "documento_digital_enviado_email");

    renderList(pedidosList, pedidos, "pedidos", "Nenhum pedido pendente de análise.");
    renderList(producaoList, producao, "producao", "Nenhum documento em produção no momento.");
    renderList(assinaturasList, assinaturas, "assinaturas", "Nenhum pedido aguardando assinatura.");
    renderList(prontoList, pronto, "pronto", "Nenhum documento pronto aguardando liberação.");
    renderList(fisicosList, fisicos, "fisicos", "Nenhuma pendência de documento físico no momento.");

    setStatus(
      `Painel atualizado: ${pedidos.length} em Pedidos, ${producao.length} em Produção, ${assinaturas.length} em Assinaturas Pendentes, ${pronto.length} em Documento Pronto e ${fisicos.length} em Pendência Física.`,
      "ok"
    );
  }

  function setActiveTab(tabName) {
    tabButtons.forEach((button) => {
      const isTarget = button.dataset.tabTarget === tabName;
      button.classList.toggle("is-active", isTarget);
    });

    tabPanels.forEach((panel) => {
      const isTarget = panel.dataset.tabPanel === tabName;
      panel.hidden = !isTarget;
    });
  }

  async function handleAdminAction(event) {
    const actionButton = event.target.closest("button[data-action]");
    if (!actionButton) return;

    const action = actionButton.dataset.action;
    const requestId = actionButton.dataset.requestId;
    const requestRow = requestsById.get(requestId);

    if (!requestRow) {
      setStatus("Pedido não encontrado. Atualize a lista.", "error");
      return;
    }

    if (action === "open-id") {
      await openIdDocument(requestRow);
      return;
    }
    if (action === "open-final") {
      await openProducedDocument(requestRow);
      return;
    }

    setButtonLoading(actionButton, true, "Processando...");

    try {
      if (action === "approve-identity") {
        const transitioned = await transitionRequestStatus(requestRow, "documento_em_producao", {
          producingStartedAt: new Date().toISOString(),
          historyNote: "Identidade validada pela secretaria/admin. Pedido movido para produção."
        });

        await sendWorkflowEmail({
          event_type: "documento_em_producao",
          request_id: transitioned.id,
          protocol: transitioned.protocol,
          document_label: documentLabel(transitioned),
          user_name: transitioned.requester_name,
          user_email: transitioned.requester_email,
          profile: transitioned.form_type,
          status: transitioned.status
        });

        setStatus(`Pedido ${transitioned.protocol} atualizado para Documento em produção.`, "ok");
      } else if (action === "upload-and-move-signatures") {
        const card = actionButton.closest("[data-request-card]");
        const fileInput = card?.querySelector(`[data-produced-file-input="${requestRow.id}"]`);
        const file = fileInput?.files?.[0];
        if (!file) {
          throw new Error("Selecione o PDF do documento produzido antes de continuar.");
        }
        if (file.type !== "application/pdf") {
          throw new Error("Arquivo inválido. Envie um PDF.");
        }

        const producedPath = await uploadProducedPdf(requestRow, file);
        const mergedPayload = {
          ...(requestRow.payload || {}),
          produced_document_path: producedPath,
          produced_document_name: file.name,
          produced_document_uploaded_at: new Date().toISOString()
        };

        const { data: rowWithProducedDoc, error: producedDocError } = await supabaseClient
          .from("lp_document_requests")
          .update({
            payload: mergedPayload
          })
          .eq("id", requestRow.id)
          .select("*")
          .single();

        if (producedDocError) {
          throw new Error(`Não foi possível salvar referência do PDF produzido: ${producedDocError.message}`);
        }

        const transitioned = await startClicksignSignature(rowWithProducedDoc, producedPath, file.name);
        setStatus(
          `PDF enviado e pedido ${transitioned.protocol} movido para Assinaturas Pendentes (Clicksign iniciado).`,
          "ok"
        );
      } else if (action === "refresh-signature-status") {
        setStatus("Status de assinaturas atualizado via webhook da Clicksign. Clique em Atualizar lista.", "ok");
      } else if (action === "sign-clicksign") {
        debugLog("Ação sign-clicksign: clique detectado", { request_id: requestRow.id });
        let rowForSignature = requestRow;
        const role = currentOperatorRole();
        const operatorEmail = currentOperatorEmail();
        if (role === "admin" && operatorEmail !== DIRECTOR_EMAIL) {
          throw new Error("A assinatura de diretor só pode ser feita pelo e-mail diretor@einsteinhub.co.");
        }
        if (role === "secretaria" && operatorEmail !== SECRETARIA_EMAIL) {
          throw new Error("A assinatura de secretaria só pode ser feita pelo e-mail secretaria@einsteinhub.co.");
        }
        const EXPECTED_SECRETARIA_EMAIL = "secretaria@einsteinhub.co";
        const signerKey = role === "admin" ? "clicksign_signer_admin_id" : "clicksign_signer_secretaria_id";
        const hasClicksignFlow =
          !!rowForSignature.clicksign_envelope_id &&
          !!rowForSignature.clicksign_document_id &&
          !!rowForSignature[signerKey];
        const secretariaEmailOnPayload =
          String(rowForSignature.payload?.clicksign?.signer_secretaria_email || "").toLowerCase();
        const needsSecretariaFlowRecreate =
          role === "secretaria" &&
          (!!rowForSignature.clicksign_envelope_id) &&
          secretariaEmailOnPayload !== EXPECTED_SECRETARIA_EMAIL;

        if (!hasClicksignFlow || needsSecretariaFlowRecreate) {
          debugLog("Fluxo Clicksign não iniciado. Iniciando agora...", {
            request_id: rowForSignature.id,
            role,
            has_flow: hasClicksignFlow,
            needs_secretaria_recreate: needsSecretariaFlowRecreate,
            secretaria_email_payload: secretariaEmailOnPayload || null
          });
          const producedPath = rowForSignature.payload?.produced_document_path;
          const producedName = rowForSignature.payload?.produced_document_name || "documento-final.pdf";
          if (!producedPath) {
            throw new Error("Este pedido ainda não tem PDF final vinculado. Envie o PDF em 'Documentos em Produção'.");
          }

          rowForSignature = await startClicksignSignature(rowForSignature, producedPath, producedName);
          debugLog("startClicksignSignature: concluído", {
            request_id: rowForSignature.id,
            envelope_id: rowForSignature.clicksign_envelope_id,
            signer_admin_id: rowForSignature.clicksign_signer_admin_id,
            signer_secretaria_id: rowForSignature.clicksign_signer_secretaria_id
          });
        }

        const signatureRequest = await requestClicksignSignature(rowForSignature);
        debugLog("requestClicksignSignature: payload final", signatureRequest);
        if (signatureRequest.embedded_signer_key) {
          const env = "sandbox";
          const returnUrl = new URL("admin-dashboard.html", window.location.href);
          returnUrl.searchParams.set("clicksign_signed", "1");
          returnUrl.searchParams.set("request_id", rowForSignature.id);
          returnUrl.searchParams.set("role", role);
          const embeddedUrl =
            `clicksign-embedded.html?signer_key=${encodeURIComponent(signatureRequest.embedded_signer_key)}&env=${encodeURIComponent(env)}&request_id=${encodeURIComponent(rowForSignature.id)}&role=${encodeURIComponent(role)}&return_url=${encodeURIComponent(returnUrl.toString())}`;
          const opened = window.open(embeddedUrl, "_blank", "noopener,noreferrer");
          debugLog("Abrindo embedded_url", { url: embeddedUrl, opened: Boolean(opened) });
          if (!opened) {
            window.location.href = embeddedUrl;
          }
          setStatus("Assinatura incorporada aberta.", "ok");
        } else if (signatureRequest.signing_url) {
          const opened = window.open(signatureRequest.signing_url, "_blank", "noopener,noreferrer");
          debugLog("Abrindo signing_url", { url: signatureRequest.signing_url, opened: Boolean(opened) });
          if (!opened) {
            window.location.href = signatureRequest.signing_url;
          }
          setStatus("Link de assinatura aberto na Clicksign.", "ok");
        } else {
          setStatus("Não foi possível obter URL de assinatura para este signatário.", "error");
        }
      } else if (action === "release-digital-email") {
        const released = await transitionRequestStatus(requestRow, "documento_digital_enviado_email", {
          digitalSentAt: new Date().toISOString(),
          historyNote: "Envio digital liberado manualmente pela secretaria/admin.",
          historyMetadata: { secretaria_release_email_at: new Date().toISOString() }
        });

        await sendWorkflowEmail({
          event_type: "documento_digital_enviado_email",
          request_id: released.id,
          protocol: released.protocol,
          document_label: documentLabel(released),
          user_name: released.requester_name,
          user_email: released.requester_email,
          profile: released.form_type,
          status: released.status,
          force_refresh_signed_document: true
        });

        setStatus(`Documento digital liberado e enviado ao usuário (${released.protocol}).`, "ok");
      } else if (action === "resend-digital-email") {
        await sendWorkflowEmail({
          event_type: "documento_digital_enviado_email",
          request_id: requestRow.id,
          protocol: requestRow.protocol,
          document_label: documentLabel(requestRow),
          user_name: requestRow.requester_name,
          user_email: requestRow.requester_email,
          profile: requestRow.form_type,
          status: requestRow.status,
          force_refresh_signed_document: true
        });
        setStatus(`Reenvio digital disparado para o usuário (${requestRow.protocol}).`, "ok");
      } else if (action === "mark-physical-ready") {
        const transitioned = await transitionRequestStatus(requestRow, "documento_fisico_disponivel_secretaria", {
          physicalReadyAt: new Date().toISOString(),
          historyNote: "Documento físico confirmado como disponível na secretaria."
        });

        await sendWorkflowEmail({
          event_type: "documento_fisico_disponivel_secretaria",
          request_id: transitioned.id,
          protocol: transitioned.protocol,
          document_label: documentLabel(transitioned),
          user_name: transitioned.requester_name,
          user_email: transitioned.requester_email,
          profile: transitioned.form_type,
          status: transitioned.status
        });

        setStatus(`Pedido ${transitioned.protocol} marcado como disponível para retirada física.`, "ok");
      }

      await loadAdminRequests();
    } catch (error) {
      debugLog("Erro em handleAdminAction", {
        action,
        request_id: requestId,
        message: error?.message || String(error)
      });
      setStatus(`Não foi possível executar a ação: ${error.message}`, "error");
    } finally {
      setButtonLoading(actionButton, false);
    }
  }

  async function validateAdminAccess() {
    const params = new URLSearchParams(window.location.search);
    const hasFreshAdminLogin = params.get("fresh_admin_login") === "1";
    const isClicksignReturn = params.get("clicksign_signed") === "1";

    if (!hasFreshAdminLogin && !isClicksignReturn) {
      await supabaseClient.auth.signOut();
      window.location.href = adminLoginUrl();
      return false;
    }

    const { data } = await supabaseClient.auth.getSession();
    const user = data.session?.user;

    if (!user) {
      window.location.href = adminLoginUrl();
      return false;
    }

    const email = (user.email || "").toLowerCase();
    if (!ADMIN_EMAILS.has(email)) {
      await supabaseClient.auth.signOut();
      adminIdentityChip.textContent = "acesso não autorizado";
      setStatus("Somente diretor@einsteinhub.co e secretaria@einsteinhub.co podem acessar este painel.", "error");
      setTimeout(() => {
        window.location.href = adminLoginUrl();
      }, 1200);
      return false;
    }

    adminUser = user;
    adminIdentityChip.textContent = `acesso autorizado: ${email}`;
    return true;
  }

  tabButtons.forEach((button) => {
    button.addEventListener("click", function () {
      setActiveTab(button.dataset.tabTarget);
    });
  });

  [pedidosList, producaoList, assinaturasList, prontoList, fisicosList].forEach((listEl) => {
    listEl?.addEventListener("click", handleAdminAction);
  });

  btnAtualizarAdmin?.addEventListener("click", loadAdminRequests);

  btnSairAdmin?.addEventListener("click", async function () {
    window.location.href = "index.html";
    try {
      await supabaseClient.auth.signOut();
    } catch (error) {
      console.warn("Falha ao encerrar sessão no admin:", error);
    }
  });

  (async function init() {
    const hasAccess = await validateAdminAccess();
    if (!hasAccess) return;
    stripFreshAdminLoginParam();
    setActiveTab("pedidos");
    await loadAdminRequests();
    await processClicksignReturn();
  })();
})();
