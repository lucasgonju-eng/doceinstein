# Deploy automático no Hostinger

Este projeto publica automaticamente no Hostinger via GitHub Actions quando houver push na branch `main`, usando FTP/SFTP com usuário e senha.

## 1) Pré-requisitos no Hostinger

- Criar o subdomínio `doceinstein.einsteinhub.co`.
- Configurar o document root do subdomínio (exemplo comum: `public_html/doceinstein`).
- Garantir acesso FTP ou SFTP habilitado no plano da hospedagem.

## 2) DNS do subdomínio

- No painel DNS de `einsteinhub.co`, criar/ajustar registro para `doceinstein`.
- Usar os dados recomendados pelo Hostinger (A/CNAME).
- Aguardar propagação.

## 3) Secrets no GitHub

No repositório `lucasgonju-eng/doceinstein`, adicionar os secrets:

- `HOSTINGER_HOST` (ex.: `srvXXX.hostinger.com`)
- `HOSTINGER_PORT` (geralmente `21` para FTP ou `22` para SFTP)
- `HOSTINGER_USER` (usuário FTP/SFTP)
- `HOSTINGER_PASSWORD` (senha FTP/SFTP)
- `HOSTINGER_REMOTE_PATH` (ex.: `/home/usuario/public_html/doceinstein/`)
- `HOSTINGER_PROTOCOL` (opcional: `ftp`, `ftps` ou `sftp`; padrão `ftp`)

## 4) O que é publicado

O workflow publica os arquivos estáticos do SaaS e exclui:

- `.git/`, `.github/`, `.gitignore`
- `supabase/`
- `*.sql`
- `README.txt`

## 5) Execução do deploy

- Automático: push para `main`.
- Manual: aba Actions > workflow `Deploy Hostinger` > `Run workflow`.

## 6) Verificação pós-deploy

- Abrir `https://doceinstein.einsteinhub.co`.
- Testar login, dashboard e fluxo administrativo.
- Validar chamadas para Supabase e funções (`functions/v1/*`).

