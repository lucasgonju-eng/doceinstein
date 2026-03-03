(function () {
  const SUPABASE_URL = "https://ijyuinzducrtgerupcyk.supabase.co";
  const SUPABASE_ANON_KEY = "sb_publishable_CQADd4bRX_ZCEZkGaYNiMg_a3vlohsO";
  const PUBLIC_APP_ORIGIN = "https://doceinstein.einsteinhub.co";
  const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  const params = new URLSearchParams(window.location.search);
  const perfil = (params.get("perfil") || "aluno").toLowerCase();
  const perfilChip = document.getElementById("perfilChip");
  const statusMsg = document.getElementById("statusMsg");
  const form = document.getElementById("novaSenhaForm");
  const btn = document.getElementById("btnCriarSenha");

  if (perfilChip) perfilChip.textContent = perfil.replace("-", " ");

  function setStatus(message, type) {
    statusMsg.textContent = message;
    statusMsg.classList.remove("ok", "error");
    if (type) statusMsg.classList.add(type);
  }

  function appOrigin() {
    return PUBLIC_APP_ORIGIN;
  }

  function dashboardUrl(profile) {
    return `${appOrigin()}/dashboard.html?perfil=${encodeURIComponent(profile || "aluno")}`;
  }

  async function handleSignOut() {
    await supabaseClient.auth.signOut();
    window.location.href = "index.html";
  }

  function bindSignOutButton(button) {
    if (!button || button.dataset.signoutBound === "1") return;
    button.dataset.signoutBound = "1";
    button.addEventListener("click", function () {
      setStatus("Saindo da conta...", "");
      handleSignOut();
    });
  }

  function ensureLogoutButton() {
    const actions = form?.querySelector(".stitch-subpage-actions");
    if (!actions) return;
    let button = actions.querySelector('[data-global-signout="1"]');
    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.className = "stitch-btn stitch-btn-ghost";
      button.dataset.globalSignout = "1";
      button.textContent = "Sair";
      actions.appendChild(button);
    }
    bindSignOutButton(button);
  }

  async function ensureSession() {
    const sessionData = await supabaseClient.auth.getSession();
    if (sessionData.data.session) return sessionData.data.session;

    // Some magic links require explicit token exchange.
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const accessToken = hash.get("access_token");
    const refreshToken = hash.get("refresh_token");
    if (accessToken && refreshToken) {
      const exchanged = await supabaseClient.auth.setSession({
        access_token: accessToken,
        refresh_token: refreshToken
      });
      return exchanged.data.session;
    }
    return null;
  }

  ensureLogoutButton();

  form.addEventListener("submit", async function (event) {
    event.preventDefault();
    setStatus("", "");

    const senha = document.getElementById("senha").value;
    const confirmarSenha = document.getElementById("confirmarSenha").value;

    if (!senha || !confirmarSenha) {
      setStatus("Preencha senha e confirmação.", "error");
      return;
    }

    if (senha.length < 6) {
      setStatus("A senha precisa ter pelo menos 6 caracteres.", "error");
      return;
    }

    if (senha !== confirmarSenha) {
      setStatus("As senhas não conferem. Faça o double check e tente novamente.", "error");
      return;
    }

    btn.disabled = true;
    btn.textContent = "Confirmando...";

    const session = await ensureSession();
    if (!session) {
      btn.disabled = false;
      btn.textContent = "Confirmar e entrar";
      setStatus("Sessão de validação não encontrada. Abra novamente o magic link do e-mail.", "error");
      return;
    }

    const { error } = await supabaseClient.auth.updateUser({ password: senha });

    btn.disabled = false;
    btn.textContent = "Confirmar e entrar";

    if (error) {
      setStatus(`Não foi possível criar a senha: ${error.message}`, "error");
      return;
    }

    setStatus("Senha criada com sucesso. Entrando no dashboard...", "ok");
    const profileFromMeta = session.user?.user_metadata?.perfil || perfil;
    window.location.href = dashboardUrl(profileFromMeta);
  });
})();
