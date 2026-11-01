export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

export interface EmailFrom {
  name: string;
  address: string;
}

export const EMAIL_REQUEST_TIMEOUT_IN_MS = 10_000;
