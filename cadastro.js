(function () {
  const SUPABASE_URL = "https://ijyuinzducrtgerupcyk.supabase.co";
  const SUPABASE_ANON_KEY = "sb_publishable_CQADd4bRX_ZCEZkGaYNiMg_a3vlohsO";
  const PUBLIC_APP_ORIGIN = "https://doceinstein.einsteinhub.co";

  const params = new URLSearchParams(window.location.search);
  const profileFromQuery = params.get("perfil");
  const profileFromPage = document.body.dataset.profile;
  const perfil = (profileFromPage || profileFromQuery || "aluno").toLowerCase();
  const redirectParam = params.get("redirect");
  const isAdminRedirectRequested = (redirectParam || "").startsWith("admin-dashboard.html");

  const ADMIN_EMAILS = new Set([
    "diretor@einsteinhub.co",
    "secretaria@einsteinhub.co"
  ]);

  const perfilChip = document.getElementById("perfilChip");
  const cadastroForm = document.getElementById("cadastroForm");
  const loginForm = document.getElementById("loginForm");
  const btnIrLogin = document.getElementById("btnIrLogin");
  const btnVoltarCadastro = document.getElementById("btnVoltarCadastro");
  const statusMsg = document.getElementById("statusMsg");
  const cadastroButton = document.getElementById("btnCadastro");
  const loginButton = document.getElementById("btnLogin");
  const loginEmailInput = document.getElementById("loginEmail");
  const pageTitle = document.getElementById("pageTitle");
  const pageSubtitle = document.getElementById("pageSubtitle");

  const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  if (perfilChip) {
    perfilChip.textContent = isAdminRedirectRequested ? "administração" : perfil.replace("-", " ");
  }
  if (document.body.dataset.profile) params.set("perfil", perfil);

  function dashboardUrl(profile) {
    return `dashboard.html?perfil=${encodeURIComponent(profile || "aluno")}`;
  }

  function authRedirectOrigin() {
    // Magic link sempre volta para o domínio online publicado.
    return PUBLIC_APP_ORIGIN;
  }

  function isSafeLocalRedirect(value) {
    if (!value) return false;
    if (value.includes("://")) return false;
    return /^[a-zA-Z0-9._-]+\.html(\?.*)?$/.test(value);
  }

  function resolvePostLoginRedirect(userEmail, userProfile) {
    const normalizedEmail = (userEmail || "").toLowerCase();
    const isAdminUser = ADMIN_EMAILS.has(normalizedEmail);
    const safeRedirect = isSafeLocalRedirect(redirectParam) ? redirectParam : "";
    const redirectIsAdmin = safeRedirect.startsWith("admin-dashboard.html");
    const redirectIsUser = safeRedirect.startsWith("dashboard.html");

    // Admin pode navegar para dashboard comum, mas o destino padrão dele é admin-dashboard.
    if (isAdminUser) {
      if (safeRedirect && (redirectIsAdmin || redirectIsUser)) return safeRedirect;
      return "admin-dashboard.html";
    }

    // Usuário comum nunca entra por redirect administrativo.
    if (redirectIsAdmin) return dashboardUrl(userProfile);
    if (safeRedirect && redirectIsUser) return safeRedirect;
    return dashboardUrl(userProfile);
  }

  function setStatus(message, type) {
    if (!statusMsg) return;
    statusMsg.textContent = message;
    statusMsg.classList.remove("ok", "error");
    if (type) statusMsg.classList.add(type);
  }

  function setCadastroLoading(loading) {
    if (!cadastroButton) return;
    cadastroButton.disabled = loading;
    cadastroButton.textContent = loading ? "Enviando..." : "Continuar cadastro";
  }

  function setLoginLoading(loading) {
    if (!loginButton) return;
    loginButton.disabled = loading;
    loginButton.textContent = loading ? "Entrando..." : "Entrar";
  }

  function showLogin() {
    cadastroForm.hidden = true;
    loginForm.hidden = false;
    if (pageTitle) {
      pageTitle.textContent = isAdminRedirectRequested ? "Área de Login da Administração" : "Área de Login";
    }
    if (pageSubtitle) {
      pageSubtitle.textContent = isAdminRedirectRequested
        ? "Entre com e-mail e senha de administração para acessar o painel."
        : "Entre com e-mail e senha para acessar seu dashboard.";
    }
    const email = document.getElementById("email");
    if (email && loginEmailInput && email.value) loginEmailInput.value = email.value;
    setStatus("", "");
  }

  function showCadastro() {
    cadastroForm.hidden = false;
    loginForm.hidden = true;
    if (pageTitle) pageTitle.textContent = "Área de Cadastro";
    if (pageSubtitle) pageSubtitle.textContent = "Preencha seus dados para receber o magic link no e-mail.";
    setStatus("", "");
  }

  btnIrLogin?.addEventListener("click", showLogin);
  btnVoltarCadastro?.addEventListener("click", showCadastro);

  if (params.get("modo") === "login") showLogin();

  cadastroForm?.addEventListener("submit", async function (event) {
    event.preventDefault();
    setStatus("", "");

    const nomeCompleto = document.getElementById("nomeCompleto").value.trim();
    const cpf = document.getElementById("cpf").value.trim();
    const matricula = document.getElementById("matricula").value.trim();
    const whatsapp = document.getElementById("whatsapp").value.trim();
    const email = document.getElementById("email").value.trim().toLowerCase();

    if (!nomeCompleto || !cpf || !whatsapp || !email) {
      setStatus("Preencha os campos obrigatórios para continuar.", "error");
      return;
    }

    localStorage.setItem("doceinstein.last_nome_completo", nomeCompleto);
    localStorage.setItem("doceinstein.last_perfil", perfil);
    localStorage.setItem("doceinstein.last_email", email);

    setCadastroLoading(true);

    const { error } = await supabaseClient.auth.signInWithOtp({
      email: email,
      options: {
        shouldCreateUser: true,
        emailRedirectTo: `${authRedirectOrigin()}/nova-senha.html?perfil=${encodeURIComponent(perfil)}`,
        data: {
          nome_completo: nomeCompleto,
          cpf: cpf,
          matricula: matricula || null,
          whatsapp: whatsapp,
          perfil: perfil
        }
      }
    });

    setCadastroLoading(false);

    if (error) {
      setStatus(`Não foi possível enviar o magic link: ${error.message}`, "error");
      return;
    }

    setStatus("Cadastro enviado com sucesso. Um e-mail de validação foi enviado. Abra sua caixa de e-mails e valide seu cadastro.", "ok");
  });

  loginForm?.addEventListener("submit", async function (event) {
    event.preventDefault();
    setStatus("", "");

    const email = document.getElementById("loginEmail").value.trim().toLowerCase();
    const senha = document.getElementById("loginSenha").value;

    if (!email || !senha) {
      setStatus("Informe e-mail e senha para entrar.", "error");
      return;
    }

    setLoginLoading(true);
    const { error } = await supabaseClient.auth.signInWithPassword({ email, password: senha });
    setLoginLoading(false);

    if (error) {
      setStatus(`Login inválido: ${error.message}`, "error");
      return;
    }

    setStatus("Login realizado com sucesso.", "ok");
    const currentSession = await supabaseClient.auth.getSession();
    const user = currentSession.data.session?.user;
    const userProfile = user?.user_metadata?.perfil || perfil;
    const userEmail = (user?.email || "").toLowerCase();

    if (isAdminRedirectRequested && !ADMIN_EMAILS.has(userEmail)) {
      await supabaseClient.auth.signOut();
      setStatus("Este acesso é exclusivo para contas de administração/secretaria.", "error");
      return;
    }

    window.location.href = resolvePostLoginRedirect(userEmail, userProfile);
  });
})();
