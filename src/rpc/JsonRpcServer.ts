import * as express from "express";
import { Server } from "http";
import { Command } from "../commands/CommandHandler";

/**
 * JSON-RPC 2.0 protocol types and interfaces
 */

export interface JsonRpcRequest {
    jsonrpc: "2.0";
    method: string;
    params?: any[] | Record<string, any>;
    id?: string | number | null;
}

export interface JsonRpcSuccessResponse {
    jsonrpc: "2.0";
    result: any;
    id: string | number | null;
}

export interface JsonRpcError {
    code: number;
    message: string;
    data?: any;
}

export interface JsonRpcErrorResponse {
    jsonrpc: "2.0";
    error: JsonRpcError;
    id: string | number | null;
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

// Standard JSON-RPC 2.0 error codes
export const JsonRpcErrorCodes = {
    PARSE_ERROR: -32700,
    INVALID_REQUEST: -32600,
    METHOD_NOT_FOUND: -32601,
    INVALID_PARAMS: -32602,
    INTERNAL_ERROR: -32603,
    SERVER_ERROR: -32000
} as const;

export interface RpcConfig {
    address: string;
    port: number;
}


export class JsonRpcServer {
    private app: express.Express;
    private server: Server | null = null;
    private commands: { [key: string]: Command<any> };
    private config: RpcConfig;

    constructor(commands: { [key: string]: Command<any> }, config: RpcConfig) {
        this.commands = commands;
        this.config = config;
        this.app = express();
        this.setupMiddlewares();
        this.setupRoutes();
    }

    private setupMiddlewares(): void {
        // JSON parsing
        this.app.use(express.json());

        // JSON parsing error handler
        this.app.use((error: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
            if (error instanceof SyntaxError && 'body' in error) {
                return res.json({
                    jsonrpc: "2.0",
                    error: {
                        code: JsonRpcErrorCodes.PARSE_ERROR,
                        message: "Parse error"
                    },
                    id: null
                });
            }
            next(error);
        });
    }

    private setupRoutes(): void {
        this.app.post('/rpc', async (req: express.Request, res: express.Response) => {
            try {
                const response = await this.handleJsonRpcRequest(req.body);
                res.json(response);
            } catch (error) {
                console.error('JsonRpcServer: Unexpected error:', error);
                res.json({
                    jsonrpc: "2.0",
                    error: {
                        code: JsonRpcErrorCodes.INTERNAL_ERROR,
                        message: "Internal error",
                        data: error instanceof Error ? error.message : String(error)
                    },
                    id: null
                });
            }
        });

        // Health check endpoint
        this.app.get('/health', (req: express.Request, res: express.Response) => {
            res.json({ status: 'ok' });
        });
    }

    private async handleJsonRpcRequest(body: any): Promise<JsonRpcResponse> {
        // Check for batch requests (not supported in v1)
        if (Array.isArray(body)) {
            return {
                jsonrpc: "2.0",
                error: {
                    code: JsonRpcErrorCodes.INVALID_REQUEST,
                    message: "Batch requests not supported"
                },
                id: null
            };
        }

        // Validate JSON-RPC 2.0 request format
        if (!this.isValidJsonRpcRequest(body)) {
            return {
                jsonrpc: "2.0",
                error: {
                    code: JsonRpcErrorCodes.INVALID_REQUEST,
                    message: "Invalid Request"
                },
                id: (body && body.id !== undefined) ? body.id : null
            };
        }

        const request = body as JsonRpcRequest;
        const { method, params, id } = request;

        // Check if method exists
        const command = this.commands[method];
        if (!command) {
            return {
                jsonrpc: "2.0",
                error: {
                    code: JsonRpcErrorCodes.METHOD_NOT_FOUND,
                    message: "Method not found"
                },
                id
            };
        }

        try {
            // Parse parameters using the command's argument parser
            const parsedArgs = this.parseCommandParams(command, params);
            
            // Execute the command with a no-op sendLine callback
            const result = await command.runtime.parser(parsedArgs, () => {});
            
            return {
                jsonrpc: "2.0",
                result,
                id
            };
        } catch (error) {
            console.error(`JsonRpcServer: Command '${method}' execution error:`, error);
            
            // Check if it's a parameter parsing error
            if (error instanceof Error && error.message.includes('Parsing parameter')) {
                return {
                    jsonrpc: "2.0",
                    error: {
                        code: JsonRpcErrorCodes.INVALID_PARAMS,
                        message: "Invalid params",
                        data: error.message
                    },
                    id
                };
            }
            
            // General server error
            return {
                jsonrpc: "2.0",
                error: {
                    code: JsonRpcErrorCodes.SERVER_ERROR,
                    message: "Server error",
                    data: error instanceof Error ? error.message : String(error)
                },
                id
            };
        }
    }

    private isValidJsonRpcRequest(body: any): body is JsonRpcRequest {
        return (
            body &&
            typeof body === 'object' &&
            body.jsonrpc === "2.0" &&
            typeof body.method === 'string' &&
            (body.params === undefined || Array.isArray(body.params) || 
             (typeof body.params === 'object' && body.params !== null)) &&
            (body.id === undefined || body.id === null || 
             typeof body.id === 'string' || typeof body.id === 'number')
        );
    }

    private parseCommandParams(command: Command<any>, params: any): any {
        const paramsObj: any = {};
        
        if (!params) {
            // No parameters provided - try to parse with empty values
            for (const key in command.runtime.args) {
                try {
                    paramsObj[key] = command.runtime.args[key].parser(undefined as any);
                } catch (e) {
                    throw new Error(`Parsing parameter '${key}': ${e instanceof Error ? e.message : String(e)}`);
                }
            }
            return paramsObj;
        }

        if (Array.isArray(params)) {
            // Positional parameters - map to base arguments in order
            const baseArgs = Object.keys(command.runtime.args)
                .filter(key => command.runtime.args[key].base);
            
            for (let i = 0; i < baseArgs.length && i < params.length; i++) {
                const key = baseArgs[i];
                try {
                    paramsObj[key] = command.runtime.args[key].parser(params[i]);
                } catch (e) {
                    throw new Error(`Parsing parameter '${key}': ${e instanceof Error ? e.message : String(e)}`);
                }
            }
            
            // Parse remaining non-base parameters with undefined (will use defaults or fail)
            for (const key in command.runtime.args) {
                if (!command.runtime.args[key].base && !(key in paramsObj)) {
                    try {
                        paramsObj[key] = command.runtime.args[key].parser(undefined as any);
                    } catch (e) {
                        throw new Error(`Parsing parameter '${key}': ${e instanceof Error ? e.message : String(e)}`);
                    }
                }
            }
        } else if (typeof params === 'object') {
            // Named parameters
            for (const key in command.runtime.args) {
                try {
                    paramsObj[key] = command.runtime.args[key].parser(params[key]);
                } catch (e) {
                    throw new Error(`Parsing parameter '${key}': ${e instanceof Error ? e.message : String(e)}`);
                }
            }
        } else {
            throw new Error('Parameters must be an array or object');
        }

        return paramsObj;
    }

    async start(): Promise<void> {
        if (this.server) {
            throw new Error('JsonRpcServer: Server already started');
        }

        return new Promise<void>((resolve, reject) => {
            this.server = this.app.listen(this.config.port, this.config.address, () => {
                console.log(`JsonRpcServer: JSON-RPC server listening on ${this.config.address}:${this.config.port}`);
                resolve();
            });

            this.server.on('error', (error: any) => {
                console.error('JsonRpcServer: Server error:', error);
                reject(error);
            });
        });
    }

    async stop(): Promise<void> {
        if (!this.server) {
            return;
        }

        return new Promise<void>((resolve) => {
            this.server!.close(() => {
                console.log('JsonRpcServer: Server stopped');
                this.server = null;
                resolve();
            });
        });
    }

    isRunning(): boolean {
        return this.server !== null;
    }
}
