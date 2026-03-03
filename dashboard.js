(function () {
  const SUPABASE_URL = "https://ijyuinzducrtgerupcyk.supabase.co";
  const SUPABASE_ANON_KEY = "sb_publishable_CQADd4bRX_ZCEZkGaYNiMg_a3vlohsO";
  const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const ADMIN_EMAILS = new Set([
    "diretor@einsteinhub.co",
    "secretaria@einsteinhub.co"
  ]);

  const params = new URLSearchParams(window.location.search);
  const perfilFromQuery = (params.get("perfil") || "aluno").toLowerCase();
  const perfilChip = document.getElementById("perfilChip");
  const nomeAluno = document.getElementById("nomeAluno");
  const documentoSelect = document.getElementById("documentoSelect");
  const outrosField = document.getElementById("outrosField");
  const documentoOutro = document.getElementById("documentoOutro");
  const cpfInput = document.getElementById("cpf");
  const rgInput = document.getElementById("rg");
  const idDocumentoInput = document.getElementById("idDocumento");
  const requerimentoForm = document.getElementById("requerimentoForm");
  const statusMsg = document.getElementById("statusMsg");
  const btnSair = document.getElementById("btnSair");
  const submitButton = requerimentoForm?.querySelector('button[type="submit"]');
  const timelineProtocol = document.getElementById("timelineProtocol");
  const timelineSteps = Array.from(document.querySelectorAll(".timeline-step"));

  const TIMELINE_ORDER = [
    "requerimento_documento",
    "envio_documento_identificacao",
    "requerimento_em_analise",
    "documento_em_producao",
    "documento_pronto",
    "documento_digital_enviado_email",
    "documento_fisico_disponivel_secretaria"
  ];

  const STATUS_TO_PROGRESS_INDEX = {
    requerimento_em_analise: 2,
    documento_em_producao: 3,
    assinaturas_pendentes: 3,
    documento_pronto: 4,
    documento_digital_enviado_email: 5,
    documento_fisico_disponivel_secretaria: 6
  };

  let currentUser = null;
  let currentProfile = perfilFromQuery;

  function setStatus(message, type) {
    statusMsg.textContent = message;
    statusMsg.classList.remove("ok", "error");
    if (type) statusMsg.classList.add(type);
  }

  function setSubmitLoading(loading) {
    if (!submitButton) return;
    submitButton.disabled = loading;
    submitButton.textContent = loading ? "Registrando..." : "Registrar requerimento";
  }

  function normalizeProfile(value) {
    return (value || currentProfile || "aluno").replace("_", "-").toLowerCase();
  }

  function prettyProfile(value) {
    return normalizeProfile(value).replace("-", " ");
  }

  function sanitizeFileName(fileName) {
    return (fileName || "arquivo")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9_.-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
  }

  function protocolNow() {
    const now = new Date();
    const pad = (value) => String(value).padStart(2, "0");
    const datePart = [
      now.getFullYear(),
      pad(now.getMonth() + 1),
      pad(now.getDate())
    ].join("");
    const timePart = [pad(now.getHours()), pad(now.getMinutes()), pad(now.getSeconds())].join("");
    const randomPart = Math.floor(Math.random() * 900 + 100);
    return `REQ-${datePart}-${timePart}-${randomPart}`;
  }

  function documentLabel(docValue, otherValue) {
    if (docValue === "declaracao_transferencia") return "Declaração de Transferência";
    if (docValue === "declaracao_frequencia") return "Declaração de Frequência";
    if (docValue === "historico_certificado") return "Histórico Escolar + Certificado";
    return otherValue || "Outros";
  }

  function prazoDescricao(docValue) {
    if (docValue === "historico_certificado") return "30 dias corridos";
    return "3 dias úteis";
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
    return map[status] || "Requerimento em análise";
  }

  function markTimelineFromRequest(requestRow) {
    const hasRequest = !!requestRow;
    const progressIndex = requestRow ? (STATUS_TO_PROGRESS_INDEX[requestRow.status] ?? 2) : -1;
    const activeIndex = requestRow && progressIndex <= 3 ? progressIndex : -1;

    timelineSteps.forEach((stepEl, index) => {
      stepEl.classList.remove("is-done", "is-active");
      stepEl.setAttribute("data-state", "pending");

      if (!hasRequest) return;

      const requiresDoc = index === 1;
      if (index === 0 || (requiresDoc && requestRow.id_document_path)) {
        stepEl.classList.add("is-done");
        stepEl.setAttribute("data-state", "done");
      }

      if (index >= 2 && index < progressIndex) {
        stepEl.classList.add("is-done");
        stepEl.setAttribute("data-state", "done");
      }

      if (index === activeIndex) {
        stepEl.classList.remove("is-done");
        stepEl.classList.add("is-active");
        stepEl.setAttribute("data-state", "active");
      }

      if (index >= 2 && index <= progressIndex && activeIndex === -1) {
        stepEl.classList.add("is-done");
        stepEl.setAttribute("data-state", "done");
      }
    });

    if (!timelineProtocol) return;
    if (!requestRow) {
      timelineProtocol.textContent = "Nenhum requerimento registrado ainda.";
      return;
    }

    timelineProtocol.textContent =
      `Protocolo ${requestRow.protocol} • ${statusLabel(requestRow.status)} • Prazo ${requestRow.payload?.prazo || "a definir"}.`;
  }

  async function sendWorkflowEmail(payload) {
    try {
      const response = await fetch(`${SUPABASE_URL}/functions/v1/send-workflow-email`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: SUPABASE_ANON_KEY
        },
        body: JSON.stringify(payload)
      });
      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorBody}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Falha desconhecida no envio de e-mail.";
      console.warn("Falha de rede na notificação de workflow:", message);
      setStatus(`Aviso: o e-mail de atualização não foi enviado agora (${message}).`, "error");
    }
  }

  async function loadLatestRequest() {
    if (!currentUser) {
      markTimelineFromRequest(null);
      return;
    }

    const { data, error } = await supabaseClient
      .from("lp_document_requests")
      .select("*")
      .eq("requester_identifier", currentUser.id)
      .order("created_at", { ascending: false })
      .limit(1);

    if (error) {
      markTimelineFromRequest(null);
      setStatus(`Não foi possível carregar seu histórico: ${error.message}`, "error");
      return;
    }

    markTimelineFromRequest(data?.[0] || null);
  }

  async function hydrateSessionData() {
    const { data } = await supabaseClient.auth.getSession();
    const user = data.session?.user;
    if (!user) {
      window.location.href = "login.html?modo=login";
      return;
    }

    const userEmail = (user.email || "").toLowerCase();
    if (ADMIN_EMAILS.has(userEmail)) {
      window.location.href = "admin-dashboard.html";
      return;
    }

    currentUser = user;
    const metadata = user?.user_metadata || {};
    const perfil = normalizeProfile(metadata.perfil || perfilFromQuery);
    currentProfile = perfil;
    const nomeCompleto =
      metadata.nome_completo ||
      metadata.full_name ||
      metadata.name ||
      localStorage.getItem("doceinstein.last_nome_completo") ||
      "Aluno";

    perfilChip.textContent = prettyProfile(perfil);
    nomeAluno.textContent = nomeCompleto;

    await loadLatestRequest();
  }

  documentoSelect.addEventListener("change", function () {
    const isOutros = documentoSelect.value === "outros";
    outrosField.hidden = !isOutros;
    if (!isOutros) documentoOutro.value = "";
  });

  // Enforce hidden state on initial render
  outrosField.hidden = true;

  requerimentoForm.addEventListener("submit", async function (event) {
    event.preventDefault();
    setStatus("", "");

    if (!currentUser) {
      setStatus("Sessão inválida. Faça login novamente.", "error");
      window.location.href = "login.html?modo=login";
      return;
    }

    const docValue = documentoSelect.value;
    const cpf = (cpfInput?.value || "").trim();
    const rg = (rgInput?.value || "").trim();
    const file = idDocumentoInput?.files?.[0];

    if (!docValue) {
      setStatus("Selecione o documento para continuar.", "error");
      return;
    }

    if (docValue === "outros" && !documentoOutro.value.trim()) {
      setStatus("Descreva qual documento você precisa no campo 'Outros'.", "error");
      return;
    }

    if (!cpf || !rg) {
      setStatus("Preencha CPF e RG para enviar o requerimento.", "error");
      return;
    }

    if (!file) {
      setStatus("Envie o documento de identificação oficial (PDF ou foto).", "error");
      return;
    }

    const allowedMimeTypes = ["application/pdf", "image/jpeg", "image/png", "image/webp"];
    if (!allowedMimeTypes.includes(file.type)) {
      setStatus("Formato inválido. Envie PDF, JPG, PNG ou WEBP.", "error");
      return;
    }

    if (file.size > 10 * 1024 * 1024) {
      setStatus("Arquivo acima de 10MB. Envie um arquivo menor.", "error");
      return;
    }

    const userName =
      currentUser.user_metadata?.nome_completo ||
      currentUser.user_metadata?.name ||
      localStorage.getItem("doceinstein.last_nome_completo") ||
      "Aluno";
    const userEmail =
      currentUser.email ||
      localStorage.getItem("doceinstein.last_email") ||
      "";
    const docLabel = documentLabel(docValue, documentoOutro.value.trim());
    const prazo = prazoDescricao(docValue);
    const protocol = protocolNow();

    setSubmitLoading(true);

    const safeFileName = sanitizeFileName(file.name);
    const idDocumentPath = `${currentUser.id}/${Date.now()}-${safeFileName}`;

    const { error: uploadError } = await supabaseClient.storage
      .from("id_autorizacao_enviados")
      .upload(idDocumentPath, file, {
        upsert: false,
        contentType: file.type
      });

    if (uploadError) {
      setSubmitLoading(false);
      if (uploadError.message?.toLowerCase().includes("bucket")) {
        setStatus("Bucket 'id_autorizacao_enviados' não existe. Rode o setup SQL de workflow no Supabase.", "error");
        return;
      }
      setStatus(`Não foi possível subir o documento: ${uploadError.message}`, "error");
      return;
    }

    const initialStatus = "requerimento_em_analise";
    const insertPayload = {
      protocolo_origem: protocol,
      documento: docLabel,
      prazo: prazo,
      perfil: currentProfile,
      observacao: "Primeira via gratuita. Segunda via é paga."
    };

    const { data: createdRequest, error: requestError } = await supabaseClient
      .from("lp_document_requests")
      .insert({
        protocol: protocol,
        requester_identifier: currentUser.id,
        requester_name: userName,
        requester_email: userEmail,
        form_type: currentProfile,
        document_type: docValue,
        document_other: docValue === "outros" ? documentoOutro.value.trim() : null,
        cpf: cpf,
        rg: rg,
        whatsapp: currentUser.user_metadata?.whatsapp || null,
        matricula: currentUser.user_metadata?.matricula || null,
        id_document_path: idDocumentPath,
        id_document_mime: file.type,
        id_document_size: file.size,
        status: initialStatus,
        payload: insertPayload
      })
      .select("*")
      .single();

    if (requestError) {
      setSubmitLoading(false);
      setStatus(`Não foi possível registrar o requerimento: ${requestError.message}`, "error");
      return;
    }

    const historyRows = [
      {
        request_id: createdRequest.id,
        protocol: protocol,
        old_status: null,
        new_status: TIMELINE_ORDER[0],
        changed_by: currentUser.id,
        changed_by_email: userEmail,
        notes: "Requerimento criado pelo usuário.",
        metadata: {}
      },
      {
        request_id: createdRequest.id,
        protocol: protocol,
        old_status: TIMELINE_ORDER[0],
        new_status: TIMELINE_ORDER[1],
        changed_by: currentUser.id,
        changed_by_email: userEmail,
        notes: "Documento de identificação enviado para análise.",
        metadata: { id_document_path: idDocumentPath }
      },
      {
        request_id: createdRequest.id,
        protocol: protocol,
        old_status: TIMELINE_ORDER[1],
        new_status: TIMELINE_ORDER[2],
        changed_by: currentUser.id,
        changed_by_email: userEmail,
        notes: "Requerimento encaminhado para análise da secretaria.",
        metadata: {}
      }
    ];

    const { error: historyError } = await supabaseClient
      .from("lp_request_status_history")
      .insert(historyRows);

    if (historyError) {
      console.warn("Falha ao registrar histórico:", historyError.message);
    }

    await sendWorkflowEmail({
      event_type: "novo_requerimento",
      request_id: createdRequest.id,
      protocol: protocol,
      document_label: docLabel,
      prazo: prazo,
      user_name: userName,
      user_email: userEmail,
      profile: currentProfile,
      status: initialStatus,
      destination_emails: [
        "diretor@einsteinhub.co",
        "secretaria@einsteinhub.co"
      ],
      id_document_path: idDocumentPath
    });

    await sendWorkflowEmail({
      event_type: "requerimento_em_analise",
      request_id: createdRequest.id,
      protocol: protocol,
      document_label: docLabel,
      prazo: prazo,
      user_name: userName,
      user_email: userEmail,
      profile: currentProfile,
      status: initialStatus
    });

    setSubmitLoading(false);
    setStatus(
      `Requerimento registrado com sucesso (protocolo ${protocol}). Documento de identificação enviado para análise da secretaria.`,
      "ok"
    );

    requerimentoForm.reset();
    outrosField.hidden = true;
    await loadLatestRequest();
  });

  btnSair.addEventListener("click", async function () {
    window.location.href = "index.html";
    try {
      await supabaseClient.auth.signOut();
    } catch (error) {
      console.warn("Falha ao encerrar sessão no dashboard:", error);
    }
  });

  markTimelineFromRequest(null);
  hydrateSessionData();
})();
