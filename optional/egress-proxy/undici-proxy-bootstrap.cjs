'use strict';

try {
  const { EnvHttpProxyAgent, setGlobalDispatcher } = require('undici');

  const proxyUrl =
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    process.env.https_proxy ||
    process.env.http_proxy;

  if (proxyUrl) {
    setGlobalDispatcher(new EnvHttpProxyAgent());
    console.log(`[proxy-bootstrap] undici env proxy enabled: ${proxyUrl}`);
  } else {
    console.log('[proxy-bootstrap] no HTTP(S)_PROXY configured');
  }
} catch (error) {
  console.error('[proxy-bootstrap] failed to configure undici proxy:', error);
}
