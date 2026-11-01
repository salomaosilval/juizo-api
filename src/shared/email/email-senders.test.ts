import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEmailSender } from './create-email-sender.js';
import { buildTestEnv } from '../../../test/env.fixture.js';

const message = {
  to: 'rafael@example.com',
  subject: 'Assunto',
  html: '<p>Corpo</p>',
  text: 'Corpo',
};

function stubFetch(status: number) {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function requestOf(fetchMock: ReturnType<typeof stubFetch>) {
  const [url, init] = fetchMock.mock.calls[0] ?? [];
  return {
    url: (url as string | URL).toString(),
    headers: new Headers(init?.headers),
    body: JSON.parse(init?.body as string) as Record<string, unknown>,
  };
}

const resendSender = () =>
  createEmailSender(buildTestEnv({ EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_secret_key' }));

describe('email senders', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends through Resend with the API key and sender', async () => {
    const fetchMock = stubFetch(200);

    await resendSender().send(message);

    const { url, headers, body } = requestOf(fetchMock);
    expect(url).toBe('https://api.resend.com/emails');
    expect(headers.get('authorization')).toBe('Bearer re_secret_key');
    expect(body).toEqual({
      from: 'Juízo <ola@juizo.test>',
      to: ['rafael@example.com'],
      subject: 'Assunto',
      html: '<p>Corpo</p>',
      text: 'Corpo',
    });
  });

  it('fails when Resend rejects the email, without exposing the API key', async () => {
    stubFetch(403);

    const error: unknown = await resendSender()
      .send(message)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain('403');
    expect(String(error)).not.toContain('re_secret_key');
  });

  it('sends through Mailpit outside production', async () => {
    const fetchMock = stubFetch(200);

    await createEmailSender(buildTestEnv({ MAILPIT_URL: 'http://mailpit.test:8025' })).send(
      message,
    );

    const { url, body } = requestOf(fetchMock);
    expect(url).toBe('http://mailpit.test:8025/api/v1/send');
    expect(body).toMatchObject({
      From: { Name: 'Juízo', Email: 'ola@juizo.test' },
      To: [{ Email: 'rafael@example.com' }],
    });
  });

  it('fails when Mailpit rejects the email', async () => {
    stubFetch(500);

    await expect(createEmailSender(buildTestEnv()).send(message)).rejects.toThrow('500');
  });
});
