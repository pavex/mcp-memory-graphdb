// stdout carries the MCP protocol, so every line goes to stderr - MCP
// clients and the hub pass a server's stderr through to their log.
/** Writes what the server does to stderr, one timestamped line each. */
export class Logger {

    /** `print`: false keeps it quiet (tests). */
    constructor(private print = true) {
    }


    /** Writes one line: <ISO time> [memory] message. */
    write(message: string): void {
        if (this.print) {
            console.error(`${new Date().toISOString()} [memory] ${message}`)
        }
    }
}
