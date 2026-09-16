import { spawn } from 'node:child_process';

const email = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

export function validateSmtp(input) {
  if (typeof input.host !== 'string' || !/^[a-zA-Z0-9.-]{1,253}$/.test(input.host) || input.host.includes('..')) return 'Enter a valid SMTP host.';
  const port = Number(input.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return 'Enter a valid SMTP port.';
  if (!['tls', 'starttls'].includes(input.security)) return 'Choose TLS or STARTTLS.';
  if (typeof input.from !== 'string' || !email.test(input.from) || input.from.length > 254) return 'Enter a valid sender email address.';
  if (typeof input.username !== 'string' || input.username.length > 254 || /[\r\n]/.test(input.username)) return 'Enter a valid SMTP username.';
  if (input.password !== undefined && (typeof input.password !== 'string' || input.password.length > 1024)) return 'Invalid SMTP password.';
  return null;
}

const python = `import json, sys, ssl, smtplib
from email.message import EmailMessage
data = json.load(sys.stdin)
config, recipient = data['config'], data['recipient']
message = EmailMessage()
message['From'] = config['from']
message['To'] = recipient
message['Subject'] = 'LightNAS SMTP test'
message.set_content('This test confirms that LightNAS can send mail through your configured SMTP server.')
context = ssl.create_default_context()
try:
    if config['security'] == 'tls':
        client = smtplib.SMTP_SSL(config['host'], int(config['port']), timeout=12, context=context)
    else:
        client = smtplib.SMTP(config['host'], int(config['port']), timeout=12)
        client.ehlo()
        client.starttls(context=context)
    with client:
        client.ehlo()
        if config['username']:
            client.login(config['username'], config.get('password', ''))
        client.send_message(message)
except Exception as exc:
    print(type(exc).__name__, file=sys.stderr)
    sys.exit(1)
`;

export async function sendSmtpTest(config, recipient) {
  if (typeof recipient !== 'string' || !email.test(recipient) || recipient.length > 254) throw Object.assign(new Error('Enter a valid recipient email address.'), { status: 400 });
  return new Promise((resolve, reject) => {
    const child = spawn('python3', ['-c', python], { stdio: ['pipe', 'ignore', 'pipe'], timeout: 20000 });
    let message = '';
    child.stderr.on('data', chunk => { message = (message + chunk.toString()).slice(0, 600); });
    child.on('error', () => reject(Object.assign(new Error('Python 3 is required for SMTP delivery.'), { status: 409 })));
    child.on('close', code => code === 0 ? resolve() : reject(Object.assign(new Error(`SMTP test failed: ${message.trim() || 'Connection timed out or failed.'}`), { status: 409 })));
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ config, recipient }));
  });
}
