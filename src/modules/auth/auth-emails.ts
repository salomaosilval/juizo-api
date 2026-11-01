import type { EmailMessage } from '../../shared/email/email-sender.js';

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

interface EmailContent {
  to: string;
  subject: string;
  title: string;
  paragraphs: string[];
  action?: { label: string; url: string };
  footnote: string;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character] ?? character);
}

function renderHtml({ title, paragraphs, action, footnote }: EmailContent): string {
  const body = paragraphs
    .map(
      (paragraph) =>
        `<p style="margin:0 0 16px;color:#5E6662;font-size:16px;line-height:24px">${escapeHtml(paragraph)}</p>`,
    )
    .join('');
  const button = action
    ? `<a href="${escapeHtml(action.url)}" style="display:block;margin:8px 0 24px;padding:14px 24px;background:#1F7A5A;border-radius:14px;color:#FFFFFF;font-size:16px;font-weight:700;text-align:center;text-decoration:none">${escapeHtml(action.label)}</a>`
    : '';

  return `<!doctype html>
<html lang="pt-BR">
<body style="margin:0;padding:32px 24px;background:#FBF8F3;font-family:Inter,Arial,sans-serif">
<div style="max-width:552px;margin:0 auto">
<p style="margin:0 0 16px;color:#1C1F1E;font-size:26px;font-weight:700">juízo</p>
<div style="padding:32px;background:#FFFFFF;border-radius:24px">
<h1 style="margin:0 0 16px;color:#1C1F1E;font-size:28px;line-height:34px">${escapeHtml(title)}</h1>
${body}
${button}
<p style="margin:0;color:#8A918D;font-size:13px;line-height:20px">${escapeHtml(footnote)}</p>
</div>
</div>
</body>
</html>`;
}

function renderText({ title, paragraphs, action, footnote }: EmailContent): string {
  return [
    title,
    ...paragraphs,
    ...(action ? [`${action.label}: ${action.url}`] : []),
    footnote,
  ].join('\n\n');
}

function buildEmail(content: EmailContent): EmailMessage {
  return {
    to: content.to,
    subject: content.subject,
    html: renderHtml(content),
    text: renderText(content),
  };
}

function linkWithToken(webAppUrl: string, path: string, token: string): string {
  return new URL(`${path}#token=${token}`, webAppUrl).toString();
}

export function buildRegistrationLinkEmail(
  to: string,
  webAppUrl: string,
  token: string,
): EmailMessage {
  return buildEmail({
    to,
    subject: 'Confirme seu e-mail para criar sua conta no Juízo',
    title: 'Falta só confirmar seu e-mail.',
    paragraphs: ['Clique no botão abaixo para escolher sua senha e criar a conta.'],
    action: {
      label: 'Confirmar e criar conta',
      url: linkWithToken(webAppUrl, '/finalizar-cadastro', token),
    },
    footnote: 'O link vale por 24 horas. Se você não pediu, ignore este e-mail: nada foi criado.',
  });
}

export function buildAccountAlreadyExistsEmail(to: string, webAppUrl: string): EmailMessage {
  return buildEmail({
    to,
    subject: 'Você já tem uma conta no Juízo',
    title: 'Este e-mail já tem uma conta.',
    paragraphs: [
      'Recebemos um pedido de cadastro com este e-mail. Sua conta continua como estava.',
    ],
    action: { label: 'Entrar no Juízo', url: new URL('/entrar', webAppUrl).toString() },
    footnote:
      'Esqueceu a senha? Use a opção "Esqueci a senha" na tela de entrada. Se não foi você, ignore este e-mail.',
  });
}

export function buildPasswordResetEmail(
  to: string,
  webAppUrl: string,
  token: string,
): EmailMessage {
  return buildEmail({
    to,
    subject: 'Seu link para criar uma senha nova',
    title: 'Vamos criar uma senha nova.',
    paragraphs: ['Clique no botão abaixo para escolher sua nova senha.'],
    action: { label: 'Criar senha nova', url: linkWithToken(webAppUrl, '/redefinir-senha', token) },
    footnote:
      'O link vale por 30 minutos. Se você não pediu, ignore este e-mail: sua senha continua a mesma.',
  });
}

export function buildPasswordChangedEmail(to: string, webAppUrl: string): EmailMessage {
  return buildEmail({
    to,
    subject: 'Sua senha do Juízo foi alterada',
    title: 'Sua senha foi alterada.',
    paragraphs: [
      'Por segurança, encerramos todas as sessões abertas. Entre de novo com a senha nova.',
    ],
    action: { label: 'Entrar no Juízo', url: new URL('/entrar', webAppUrl).toString() },
    footnote: 'Se não foi você, use "Esqueci a senha" agora para recuperar o acesso.',
  });
}
