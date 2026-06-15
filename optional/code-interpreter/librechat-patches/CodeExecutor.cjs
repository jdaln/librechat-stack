'use strict';

var dotenv = require('dotenv');
var fetch = require('node-fetch');
var httpsProxyAgent = require('https-proxy-agent');
var tools = require('@langchain/core/tools');
var env = require('@langchain/core/utils/env');
var _enum = require('../common/enum.cjs');

dotenv.config();
const getCodeBaseURL = () => env.getEnvironmentVariable(_enum.EnvVar.CODE_BASEURL) ??
    _enum.Constants.OFFICIAL_CODE_BASEURL;
const emptyOutputMessage = 'stdout: Empty. Ensure you\'re writing output explicitly.\n';
const SUPPORTED_LANGUAGES = [
    'py',
    'js',
    'ts',
    'c',
    'cpp',
    'java',
    'php',
    'rs',
    'go',
    'd',
    'f90',
    'r',
    'bash',
];
const CodeExecutionToolSchema = {
    type: 'object',
    properties: {
        lang: {
            type: 'string',
            enum: SUPPORTED_LANGUAGES,
            description: 'The programming language or runtime to execute the code in.',
        },
        code: {
            type: 'string',
            description: `The complete, self-contained code to execute, without any truncation or minimization.
- The environment is stateless; variables and imports don't persist between executions.
- Generated files from previous executions are automatically available in "/mnt/data/".
- Files from previous executions are automatically available and can be modified in place.
- Input code **IS ALREADY** displayed to the user, so **DO NOT** repeat it in your response unless asked.
- Output code **IS NOT** displayed to the user, so **DO** write all desired output explicitly.
- IMPORTANT: You MUST explicitly print/output ALL results you want the user to see.
- py: This is not a Jupyter notebook environment. Use \`print()\` for all outputs.
- py: Matplotlib: Use \`plt.savefig()\` to save plots as files.
- js: use the \`console\` or \`process\` methods for all outputs.
- r: IMPORTANT: No X11 display available. ALL graphics MUST use Cairo library (library(Cairo)).
- Other languages: use appropriate output functions.`,
        },
        args: {
            type: 'array',
            items: { type: 'string' },
            description: 'Additional arguments to execute the code with. This should only be used if the input code requires additional arguments to run.',
        },
    },
    required: ['lang', 'code'],
};
const baseEndpoint = getCodeBaseURL();
const EXEC_ENDPOINT = `${baseEndpoint}/exec`;
async function resolveCodeApiAuthHeaders(authHeaders) {
    if (authHeaders == null) {
        return {};
    }
    if (typeof authHeaders === 'function') {
        return authHeaders();
    }
    return authHeaders;
}
async function buildCodeApiHttpErrorMessage(method, endpoint, response) {
    let responseBody = '';
    try {
        responseBody = await response.text();
    }
    catch {
        responseBody = '';
    }
    const body = responseBody.trim();
    const bodySuffix = body === '' ? '' : `, body: ${body.slice(0, 1000)}`;
    return `CodeAPI request failed: ${method} ${endpoint} returned ${response.status}${bodySuffix}`;
}
const CodeExecutionToolDescription = `
Runs code and returns stdout/stderr output from a stateless execution environment, similar to running scripts in a command-line interface. Each execution is isolated and independent.

Usage:
- No network access available.
- Generated files are automatically delivered; **DO NOT** provide download links.
- NEVER use this tool to execute malicious code.
`.trim();
const CodeExecutionToolName = _enum.Constants.EXECUTE_CODE;
const CodeExecutionToolDefinition = {
    name: CodeExecutionToolName,
    description: CodeExecutionToolDescription,
    schema: CodeExecutionToolSchema,
};
function createCodeExecutionTool(params = {}) {
    return tools.tool(async (rawInput, config) => {
        const { authHeaders, ...executionParams } = params ?? {};
        // Local patch: see BashExecutor.cjs — JSON-Schema (not zod) doesn't
        // strip unknown fields, and weak models hallucinate extras like
        // `files: [...]` which crash codeapi with 422.
        const { lang, code, args } = rawInput ?? {};
        const modelExtras = Object.keys(rawInput ?? {}).filter(
            (k) => k !== 'lang' && k !== 'code' && k !== 'args',
        );
        if (modelExtras.length > 0) {
            // eslint-disable-next-line no-console
            console.warn(`[CodeExecutor] Dropping unsupported model-supplied fields: ${modelExtras.join(', ')}`);
        }
        /**
         * Extract session context from config.toolCall (injected by ToolNode).
         * - session_id: associates with the previous run.
         * - _injected_files: File refs to pass directly (avoids /files endpoint race condition).
         */
        const { session_id, _injected_files } = (config.toolCall ?? {});
        const postData = {
            lang,
            code,
            ...(args !== undefined ? { args } : {}),
            ...executionParams,
        };
        /* File injection: `_injected_files` from ToolNode (set when host
         * primes a CodeSessionContext) or `params.files` from tool
         * factory (set by hosts that pre-resolve at construction time).
         * The legacy `/files/<session_id>` HTTP fallback was removed —
         * codeapi's `sessionAuth` middleware now requires kind/id query
         * params the tool can't supply at this point, so the fetch 400'd
         * silently and the catch swallowed the failure. */
        if (_injected_files && _injected_files.length > 0) {
            // Local patch: drop refs missing a session id — codeapi 422s
            // the whole request if any entry lacks storage_session_id.
            const validFiles = _injected_files.filter((f) => {
                const sid = (f && (f.storage_session_id ?? f.session_id)) || '';
                return typeof sid === 'string' && sid.length > 0;
            });
            if (validFiles.length !== _injected_files.length) {
                // eslint-disable-next-line no-console
                console.warn(`[CodeExecutor] Dropping ${_injected_files.length - validFiles.length}/${_injected_files.length} injected files missing storage_session_id`);
            }
            if (validFiles.length > 0) {
                postData.files = validFiles;
            }
        }
        else if (session_id != null &&
            session_id.length > 0 &&
            !Array.isArray(postData.files)) {
            // eslint-disable-next-line no-console
            console.debug(`[CodeExecutor] No injected files for session_id=${session_id} — exec will run without input files`);
        }
        try {
            const resolvedAuthHeaders = await resolveCodeApiAuthHeaders(authHeaders);
            const fetchOptions = {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': 'LibreChat/1.0',
                    ...resolvedAuthHeaders,
                },
                body: JSON.stringify(postData),
            };
            if (process.env.PROXY != null && process.env.PROXY !== '') {
                fetchOptions.agent = new httpsProxyAgent.HttpsProxyAgent(process.env.PROXY);
            }
            const response = await fetch(EXEC_ENDPOINT, fetchOptions);
            if (!response.ok) {
                throw new Error(await buildCodeApiHttpErrorMessage('POST', EXEC_ENDPOINT, response));
            }
            const result = await response.json();
            /* Output is stdout/stderr only — file listings were removed
             * because the LLM-facing summary (split inherited/generated
             * with prescriptive notes) caused more confusion than help,
             * especially for bash where models naturally explore
             * `/mnt/data/` themselves. The artifact still carries every
             * file so the host's session map stays in sync; the LLM
             * doesn't see them in the tool result text. */
            let formattedOutput = '';
            if (result.stdout) {
                formattedOutput += `stdout:\n${result.stdout}\n`;
            }
            else {
                formattedOutput += emptyOutputMessage;
            }
            if (result.stderr)
                formattedOutput += `stderr:\n${result.stderr}\n`;
            const hasFiles = result.files != null && result.files.length > 0;
            return [
                formattedOutput.trim(),
                (hasFiles
                    ? { session_id: result.session_id, files: result.files }
                    : {
                        session_id: result.session_id,
                    }),
            ];
        }
        catch (error) {
            throw new Error(`Execution error:\n\n${error?.message}`);
        }
    }, {
        name: CodeExecutionToolName,
        description: CodeExecutionToolDescription,
        schema: CodeExecutionToolSchema,
        responseFormat: _enum.Constants.CONTENT_AND_ARTIFACT,
    });
}

exports.CodeExecutionToolDefinition = CodeExecutionToolDefinition;
exports.CodeExecutionToolDescription = CodeExecutionToolDescription;
exports.CodeExecutionToolName = CodeExecutionToolName;
exports.CodeExecutionToolSchema = CodeExecutionToolSchema;
exports.buildCodeApiHttpErrorMessage = buildCodeApiHttpErrorMessage;
exports.createCodeExecutionTool = createCodeExecutionTool;
exports.emptyOutputMessage = emptyOutputMessage;
exports.getCodeBaseURL = getCodeBaseURL;
exports.resolveCodeApiAuthHeaders = resolveCodeApiAuthHeaders;
//# sourceMappingURL=CodeExecutor.cjs.map
