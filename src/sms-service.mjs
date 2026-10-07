const DEFAULT_TIMEOUT_MS = 8000;

function gatewayConfig() {
  const baseUrl = String(process.env.LIGHTNAS_SMS_GATEWAY_URL || '').trim().replace(/\/+$/, '');
  const token = String(process.env.LIGHTNAS_SMS_GATEWAY_TOKEN || '').trim();
  return { baseUrl, token };
}

export function smsGatewayStatus() {
  const { baseUrl, token } = gatewayConfig();
  return {
    available: Boolean(baseUrl && token),
    backend: 'LightNAS SMS service',
    mode: 'centralized',
    reason: baseUrl && token
      ? ''
      : 'LightNAS SMS service is not configured on this appliance.'
  };
}

export async function sendLightNasSms({ phone, message, purpose = 'verification' } = {}) {
  const { baseUrl, token } = gatewayConfig();
  if (!baseUrl || !token) {
    throw Object.assign(new Error('LightNAS SMS service is not configured on this appliance.'), { status: 503 });
  }

  const destination = String(phone || '').trim();
  if (!/^\+[1-9]\d{7,14}$/.test(destination)) {
    throw Object.assign(new Error('Use an E.164 phone number such as +15551234567.'), { status: 400 });
  }

  const text = String(message || '').trim();
  if (!text || text.length > 480) {
    throw Object.assign(new Error('SMS message is empty or too long.'), { status: 400 });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}/v1/sms/send`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${token}`,
        'user-agent': 'LightNAS-appliance'
      },
      body: JSON.stringify({
        to: destination,
        message: text,
        purpose: String(purpose || 'verification').slice(0, 64)
      }),
      signal: controller.signal
    });

    let payload = {};
    try { payload = await response.json(); } catch {}
    if (!response.ok) {
      const detail = String(payload.error || payload.message || '').trim();
      throw Object.assign(
        new Error(detail || `LightNAS SMS service returned HTTP ${response.status}.`),
        { status: response.status >= 400 && response.status < 500 ? response.status : 502 }
      );
    }
    return {
      ok: true,
      id: payload.id || payload.messageId || null,
      provider: 'LightNAS SMS service'
    };
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw Object.assign(new Error('LightNAS SMS service timed out.'), { status: 504 });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
