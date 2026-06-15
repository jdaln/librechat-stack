'use strict';

var dotenv = require('dotenv');
var fetch = require('node-fetch');
var httpsProxyAgent = require('https-proxy-agent');
var tools = require('@langchain/core/tools');
var CodeExecutor = require('./CodeExecutor.cjs');
var _enum = require('../common/enum.cjs');

dotenv.config();
const baseEndpoint = CodeExecutor.getCodeBaseURL();
const EXEC_ENDPOINT = `${baseEndpoint}/exec`;
const BashExecutionToolSchema = {
    type: 'object',
    properties: {
        command: {
            type: 'string',
            description: `The bash command or script to execute.
- The environment is stateless; variables and state don't persist between executions.
- Generated files from previous executions are automatically available in "/mnt/data/".
- Files from previous executions are automatically available and can be modified in place.
- Input code **IS ALREADY** displayed to the user, so **DO NOT** repeat it in your response unless asked.
- Output code **IS NOT** displayed to the user, so **DO** write all desired output explicitly.
- IMPORTANT: You MUST explicitly print/output ALL results you want the user to see.
- Use \`echo\`, \`printf\`, or \`cat\` for all outputs.`,
        },
        args: {
            type: 'array',
            items: { type: 'string' },
            description: 'Additional arguments to execute the command with. This should only be used if the input command requires additional arguments to run.',
        },
    },
    required: ['command'],
};
const BashExecutionToolDescription = `
Runs bash commands and returns stdout/stderr output from a stateless execution environment, similar to running scripts in a command-line interface. Each execution is isolated and independent.

Usage:
- No network access available.
- Generated files are automatically delivered; **DO NOT** provide download links.
- NEVER use this tool to execute malicious commands.
`.trim();
/**
 * Supplemental prompt documenting the tool-output reference feature.
 *
 * Hosts should append this (separated by a blank line) to the base
 * {@link BashExecutionToolDescription} only when
 * `RunConfig.toolOutputReferences.enabled` is `true`. When the feature
 * is disabled, including this text would tell the LLM to emit
 * `{{tool0turn0}}` placeholders that pass through unsubstituted and
 * leak into the shell.
 */
const BashToolOutputReferencesGuide = `
Referencing previous tool outputs:
- Every successful tool result is tagged with a reference key of the form \`tool<idx>turn<turn>\` (e.g., \`tool0turn0\`). The key appears either as a \`[ref: tool0turn0]\` prefix line or, when the output is a JSON object, as a \`_ref\` field on the object.
- To pipe a previous tool output into this tool, embed the placeholder \`{{tool<idx>turn<turn>}}\` literally anywhere in the \`command\` string (or any string arg). It will be substituted with the stored output verbatim before the command runs.
- The substituted value is the original output string (no \`[ref: …]\` prefix, no \`_ref\` key), so it is safe to pipe directly into \`jq\`, \`grep\`, \`awk\`, etc.
- Example (simple ASCII output): \`echo '{{tool0turn0}}' | jq '.foo'\` takes the full output of the first tool from the first turn and pipes it into jq.
- For payloads that may contain quotes, parentheses, backticks, or arbitrary bytes (random/binary data, JSON with embedded quotes, multi-line strings), prefer a quoted-delimiter heredoc over \`echo '…'\`. The heredoc body is not interpreted by the shell, so substituted payloads pass through unchanged.
- Heredoc example: \`wc -c << 'EOF'\\n{{tool0turn0}}\\nEOF\` (the quotes around \`'EOF'\` disable interpolation inside the body).
- Unknown reference keys are left in place and surfaced as \`[unresolved refs: …]\` after the output.
`.trim();
/**
 * Composes the bash tool description, optionally appending the
 * tool-output references guide. Hosts that enable
 * `RunConfig.toolOutputReferences` should pass `enableToolOutputReferences: true`
 * when registering the tool so the LLM learns the `{{…}}` syntax it
 * will actually be able to use.
 */
function buildBashExecutionToolDescription(options) {
    if (options?.enableToolOutputReferences === true) {
        return `${BashExecutionToolDescription}\n\n${BashToolOutputReferencesGuide}`;
    }
    return BashExecutionToolDescription;
}
const BashExecutionToolName = _enum.Constants.BASH_TOOL;
/**
 * Default bash tool definition using the base description.
 *
 * When `RunConfig.toolOutputReferences.enabled` is `true`, build a
 * reference-aware description with
 * {@link buildBashExecutionToolDescription}
 * (`{ enableToolOutputReferences: true }`) and construct a custom
 * definition using it — using this constant as-is leaves the LLM
 * unaware of the `{{tool<i>turn<n>}}` syntax.
 */
const BashExecutionToolDefinition = {
    name: BashExecutionToolName,
    description: BashExecutionToolDescription,
    schema: BashExecutionToolSchema,
};
function createBashExecutionTool(params = {}) {
    return tools.tool(async (rawInput, config) => {
        const { authHeaders, ...executionParams } = params ?? {};
        // Local patch: BashExecutionToolSchema is JSON-Schema (not zod) so the
        // langchain wrapper doesn't strip unknown properties. Weak models often
        // hallucinate a `files: [...]` arg, which gets spread into the POST body
        // and causes codeapi to 422 with "files -> 0 -> session_id missing".
        // Forward ONLY documented schema fields.
        const { command, args } = rawInput ?? {};
        const modelExtras = Object.keys(rawInput ?? {}).filter((k) => k !== 'command' && k !== 'args');
        if (modelExtras.length > 0) {
            // eslint-disable-next-line no-console
            console.warn(`[BashExecutor] Dropping unsupported model-supplied fields: ${modelExtras.join(', ')}`);
        }
        const { session_id, _injected_files } = (config.toolCall ?? {});
        const postData = {
            lang: 'bash',
            code: command,
            ...(args !== undefined ? { args } : {}),
            ...executionParams,
        };
        /* See `CodeExecutor.ts` for the rationale — `/files/<session_id>`
         * HTTP fallback was removed because codeapi's sessionAuth requires
         * kind/id query params unavailable at this point. */
        if (_injected_files && _injected_files.length > 0) {
            // Local patch: drop refs missing a session id — codeapi rejects
            // the whole request with 422 if any entry lacks storage_session_id.
            const validFiles = _injected_files.filter((f) => {
                const sid = (f && (f.storage_session_id ?? f.session_id)) || '';
                return typeof sid === 'string' && sid.length > 0;
            });
            if (validFiles.length !== _injected_files.length) {
                // eslint-disable-next-line no-console
                console.warn(`[BashExecutor] Dropping ${_injected_files.length - validFiles.length}/${_injected_files.length} injected files missing storage_session_id`);
            }
            if (validFiles.length > 0) {
                postData.files = validFiles;
            }
        }
        else if (session_id != null &&
            session_id.length > 0 &&
            !Array.isArray(postData.files)) {
            // eslint-disable-next-line no-console
            console.debug(`[BashExecutor] No injected files for session_id=${session_id} — exec will run without input files`);
        }
        try {
            const resolvedAuthHeaders = await CodeExecutor.resolveCodeApiAuthHeaders(authHeaders);
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
                throw new Error(await CodeExecutor.buildCodeApiHttpErrorMessage('POST', EXEC_ENDPOINT, response));
            }
            const result = await response.json();
            /* See `CodeExecutor.ts` — file listings were removed from the
             * LLM-facing tool result. Bash especially benefits: models
             * naturally `ls /mnt/data/` to discover what's available
             * rather than relying on a prescriptive summary that
             * misleads as often as it helps. */
            let formattedOutput = '';
            if (result.stdout) {
                formattedOutput += `stdout:\n${result.stdout}\n`;
            }
            else {
                formattedOutput += CodeExecutor.emptyOutputMessage;
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
        name: BashExecutionToolName,
        description: BashExecutionToolDescription,
        schema: BashExecutionToolSchema,
        responseFormat: _enum.Constants.CONTENT_AND_ARTIFACT,
    });
}

exports.BashExecutionToolDefinition = BashExecutionToolDefinition;
exports.BashExecutionToolDescription = BashExecutionToolDescription;
exports.BashExecutionToolName = BashExecutionToolName;
exports.BashExecutionToolSchema = BashExecutionToolSchema;
exports.BashToolOutputReferencesGuide = BashToolOutputReferencesGuide;
exports.buildBashExecutionToolDescription = buildBashExecutionToolDescription;
exports.createBashExecutionTool = createBashExecutionTool;
//# sourceMappingURL=BashExecutor.cjs.map
