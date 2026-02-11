import * as vscode from 'vscode';
import axios from 'axios';
import MarkdownIt = require('markdown-it');

const md = new MarkdownIt();

export function activate(context: vscode.ExtensionContext) {
    const provider: vscode.LanguageModelChatProvider = {
        async provideLanguageModelChatInformation(options: { silent: boolean }, token?: vscode.CancellationToken): Promise<vscode.LanguageModelChatInformation[]> {
            if (options.silent) {
                return [];
            }
            const config = vscode.workspace.getConfiguration('codepartner');
            const modelName = config.get<string>('model') || 'default-model';
            return [{
            id: 'default-model',
            name: 'CodePartner Model',
            version: '1.0',
            family: 'codepartner',
            maxInputTokens: 8192,
            maxOutputTokens: 2048,
            capabilities: {}
            }];
        },

        async provideLanguageModelChatResponse(
            model: vscode.LanguageModelChatInformation,
            messages: readonly vscode.LanguageModelChatRequestMessage[],
            options: vscode.ProvideLanguageModelChatResponseOptions,
            progress: vscode.Progress<vscode.LanguageModelResponsePart>,
            token: vscode.CancellationToken
        ): Promise<void> {
            const config = vscode.workspace.getConfiguration('codepartner');
            const apiEndpoint = config.get<string>('apiEndpoint') || '';
            const apiKey = config.get<string>('apiKey') || '';
            const modelId = config.get<string>('model') || '';
            const maxTokens = config.get<number>('maxTokens') || 512;

            if (!apiEndpoint || !apiKey || !modelId) {
                throw new Error('Configure API endpoint, key, and model in settings.');
            }

            // Convert to OpenAI format
            const openAiMessages = messages.map(msg => ({
                role: msg.role === vscode.LanguageModelChatMessageRole.User ? 'user' : 'assistant',
                content: msg.content.map(part => {
                    if (part instanceof vscode.LanguageModelTextPart) {
                        return part.value;
                    }
                    return '';
                }).join('')
            }));

            try {
                const response = await axios.post(`${apiEndpoint}/chat/completions`, {
                    model: modelId,
                    messages: openAiMessages,
                    max_tokens: maxTokens,
                    temperature: 0.7,
                    stream: true
                }, {
                    headers: {
                        'Authorization': `Bearer ${apiKey}`,
                        'Content-Type': 'application/json'
                    },
                    responseType: 'stream'
                });

                response.data.on('data', (chunk: Buffer) => {
                    const lines = chunk.toString().split('\n');
                    for (const line of lines) {
                        if (line.startsWith('data: ')) {
                            const data = line.slice(6);
                            if (data === '[DONE]') return;
                            try {
                                const parsed = JSON.parse(data);
                                const content = parsed.choices[0]?.delta?.content || '';
                                if (content) {
                                    progress.report(new vscode.LanguageModelTextPart(content));
                                }
                            } catch {}
                        }
                    }
                });

                await new Promise((resolve, reject) => {
                    response.data.on('end', resolve);
                    response.data.on('error', reject);
                    token.onCancellationRequested(reject);
                });
            } catch (error) {
                throw new Error(`LLM request failed: ${(error as Error).message}`);
            }
        },

        async provideTokenCount(
            model: vscode.LanguageModelChatInformation,
            input: string | vscode.LanguageModelChatRequestMessage,
            token?: vscode.CancellationToken
        ): Promise<number> {
            let text: string;
            if (typeof input === 'string') {
                text = input;
            } else {
                text = input.content.map(part => {
                    if (part instanceof vscode.LanguageModelTextPart) return part.value;
                    return '';
                }).join('');
            }
            return text.split(/\s+/).length;
        }
    };

    context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider('codepartner', provider));

    // Chat Participant Handler
    const chatHandler: vscode.ChatRequestHandler = async (request: vscode.ChatRequest, chatContext: vscode.ChatContext, stream: vscode.ChatResponseStream, token: vscode.CancellationToken) => {
        const models = await vscode.lm.selectChatModels({ vendor: 'codepartner' });
        if (models.length === 0) {
            stream.markdown('No model available. Check settings.');
            return;
        }
        const selectedModel = models[0];

        // Build history
        const messages: vscode.LanguageModelChatMessage[] = [];
        for (const historyTurn of chatContext.history) {
            if (historyTurn instanceof vscode.ChatRequestTurn) {
                messages.push(vscode.LanguageModelChatMessage.User(historyTurn.prompt));
            } else if (historyTurn instanceof vscode.ChatResponseTurn) {
                let content = '';
                for (const part of historyTurn.response) {
                    if (part instanceof vscode.ChatResponseMarkdownPart) {
                        content += part.value.value;
                    }
                }
                messages.push(vscode.LanguageModelChatMessage.Assistant(content));
            }
        }
        messages.push(vscode.LanguageModelChatMessage.User(request.prompt));

        try {
            const response = await selectedModel.sendRequest(messages, {}, token);
            for await (const chunk of response.text) {
                stream.markdown(md.renderInline(chunk));
            }
        } catch (error) {
            stream.markdown(`Error: ${(error as Error).message}. Check API config.`);
        }
    };

    const participant = vscode.chat.createChatParticipant('codepartner.participant', chatHandler);
    context.subscriptions.push(participant);

    // Inline Completions
    context.subscriptions.push(vscode.languages.registerInlineCompletionItemProvider('*', {
        async provideInlineCompletionItems(document: vscode.TextDocument, position: vscode.Position, context: vscode.InlineCompletionContext, token: vscode.CancellationToken) {
            const config = vscode.workspace.getConfiguration('codepartner');
            const apiEndpoint = config.get<string>('apiEndpoint') || '';
            const apiKey = config.get<string>('apiKey') || '';
            const model = config.get<string>('model') || '';

            if (!apiEndpoint || !apiKey || !model) return;

            const prompt = document.getText(new vscode.Range(new vscode.Position(0, 0), position));
            try {
                const response = await axios.post(`${apiEndpoint}/chat/completions`, {
                    model,
                    messages: [{ role: 'user', content: `Complete this code: \n${prompt}` }],
                    max_tokens: 100,
                    temperature: 0.2
                }, {
                    headers: { 'Authorization': `Bearer ${apiKey}` }
                });
                const suggestion = response.data.choices[0].message.content;
                return [{ insertText: suggestion }];
            } catch {
                return [];
            }
        }
    }));
}

export function deactivate() {}