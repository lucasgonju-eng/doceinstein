(function () {
  const STATUS_BAR_HEIGHT = 46;
  const MIN_WIDGET_HEIGHT = 900;

  function status(msg) {
    const el = document.getElementById("status");
    if (el) el.textContent = msg;
  }

  function viewportWidgetHeight() {
    return Math.max(window.innerHeight - STATUS_BAR_HEIGHT, MIN_WIDGET_HEIGHT);
  }

  function updateContainerHeight(height) {
    const container = document.getElementById("container");
    if (!container) return;
    const nextHeight = Math.max(Number(height) || 0, viewportWidgetHeight());
    container.style.height = `${nextHeight}px`;
    container.style.minHeight = `${nextHeight}px`;
  }

  function tuneIframeLayout() {
    const iframe = document.querySelector("#container iframe");
    if (!iframe) return;
    iframe.style.width = "100%";
    iframe.style.minHeight = `${viewportWidgetHeight()}px`;
    iframe.style.height = `${viewportWidgetHeight()}px`;
    iframe.style.border = "0";
  }

  const params = new URLSearchParams(window.location.search);
  const signerKey = params.get("signer_key") || "";
  const env = (params.get("env") || "sandbox").toLowerCase();
  const requestId = params.get("request_id") || "";
  const role = (params.get("role") || "").toLowerCase();
  const returnUrl = params.get("return_url") || "admin-dashboard.html";
  const backBtn = document.getElementById("backToSaasBtn");

  function goBackToSaas(reason) {
    const target = new URL(returnUrl, window.location.href);
    if (requestId) target.searchParams.set("request_id", requestId);
    if (role) target.searchParams.set("role", role);
    target.searchParams.set("clicksign_signed", "1");
    target.searchParams.set("source", reason || "manual");
    if (window.opener && !window.opener.closed) {
      window.opener.location.href = target.toString();
      window.close();
      return;
    }
    window.location.href = target.toString();
  }

  if (backBtn) {
    backBtn.addEventListener("click", function () {
      status("Retornando para o painel...");
      goBackToSaas("manual");
    });
  }

  if (!signerKey) {
    status("Chave de assinatura não informada.");
    return;
  }

  const endpoint = env === "production"
    ? "https://app.clicksign.com"
    : "https://sandbox.clicksign.com";

  try {
    const widget = new window.Clicksign(signerKey);
    widget.endpoint = endpoint;
    updateContainerHeight(viewportWidgetHeight());
    widget.mount("container");
    tuneIframeLayout();

    const observer = new MutationObserver(() => {
      tuneIframeLayout();
    });
    observer.observe(document.getElementById("container"), { childList: true, subtree: true });

    window.addEventListener("resize", function () {
      updateContainerHeight(viewportWidgetHeight());
      tuneIframeLayout();
    });

    widget.on("loaded", function () {
      status("Assinatura pronta. Complete no widget abaixo.");
      tuneIframeLayout();
    });
    widget.on("signed", function () {
      status("Documento assinado com sucesso. Redirecionando para o painel...");
      setTimeout(function () {
        goBackToSaas("signed_event");
      }, 1200);
    });
    widget.on("resized", function (event) {
      const height = event?.data?.height;
      updateContainerHeight(height);
      tuneIframeLayout();
    });
    widget.on("error", function () {
      status("Falha ao carregar assinatura incorporada. Tente novamente.");
    });
  } catch (_error) {
    status("Erro ao iniciar o widget da Clicksign.");
  }
})();
