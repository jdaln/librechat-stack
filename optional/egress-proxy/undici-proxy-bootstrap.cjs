'use strict';

// Preloaded into every LibreChat process (NODE_OPTIONS=--require). Routes the
// app's outbound HTTP(S) through the egress proxy for both HTTP clients in use:
//   - undici (global fetch): EnvHttpProxyAgent, CONNECT tunnel for https.
//   - axios (model-list fetches): its built-in env-proxy mode forwards https URLs
//     as plain proxied requests, which squid cannot serve (502 "Read Error");
//     give it a CONNECT agent instead and disable that mode.

const proxyUrl =
  process.env.HTTPS_PROXY ||
  process.env.HTTP_PROXY ||
  process.env.https_proxy ||
  process.env.http_proxy;

if (proxyUrl) {
  try {
    const { EnvHttpProxyAgent, setGlobalDispatcher } = require('undici');
    setGlobalDispatcher(new EnvHttpProxyAgent());
    console.log(`[proxy-bootstrap] undici env proxy enabled: ${proxyUrl}`);
  } catch (error) {
    console.error('[proxy-bootstrap] failed to configure undici proxy:', error);
  }
  try {
    const axios = require('axios');
    const { HttpsProxyAgent } = require('https-proxy-agent');
    axios.defaults.proxy = false;
    axios.defaults.httpsAgent = new HttpsProxyAgent(proxyUrl);
    console.log('[proxy-bootstrap] axios https via CONNECT tunnel');
  } catch (error) {
    console.error('[proxy-bootstrap] failed to configure axios proxy:', error);
  }
} else {
  console.log('[proxy-bootstrap] no HTTP(S)_PROXY configured');
}
