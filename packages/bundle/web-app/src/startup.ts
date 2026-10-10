/**
 * The web app's command-line provider: it parses the `dsh --profile web` flag
 * family (`--host`, `--port`, `--public-url`, `--trusted-host`, `--no-open`, TLS)
 * and its `--help` text, then provides the immutable values as
 * {@link WEB_STARTUP_SERVICE}. Ordinary rows inject that service before
 * reading it from lazy config.
 * @module @deepseek-ai/dsh-web-app/startup
 */

import { networkInterfaces } from 'node:os'
import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'
import { isWildcardHost, type TlsConfig } from '@deepseek-ai/dsh-host-webserver'
import { parsePublicUrl } from './public-url.ts'

/** Stable Cordis plugin name. */
export const name = 'web-startup'

/** Services required before the flags can be resolved. */
export const inject = ['cmdlineArgs']

/** Service provided by this ordinary plugin and injected by flag-configured rows. */
export const WEB_STARTUP_SERVICE = 'webStartup'

/** What the web rows read from {@link WEB_STARTUP_SERVICE}. */
export interface WebStartupValues {
  /** Whether this invocation opens the default browser after startup. */
  openBrowser: boolean
  /** `--host`, absent when the invocation did not name one. */
  host?: string
  /** `--port`, absent when the invocation did not name one. */
  port?: number
  /**
   * `--public-url`, absent when not specified: the advertised HTTP(S) root.
   * See [public deployments](../README.md#public-deployments).
   */
  publicUrl?: string
  /** Explicit `--trusted-host` authorities, in argument order. */
  trustedHosts: string[]
  /** Whether this invocation enforces the browser token handshake (`--no-browser-auth` clears it). */
  browserAuth: boolean
  /** Server certificate chain and unencrypted private key supplied together. */
  tls?: TlsConfig
}

/** The web flag family, as commander parsed it. */
interface WebOptions {
  browserAuth: boolean
  host?: string
  open: boolean
  port?: string
  publicUrl?: string
  trustedHost?: string[]
  tlsCert?: string
  tlsKey?: string
}

/**
 * This app's command: its flags, its description, and its help text.
 * @returns a fresh program, so one process can parse more than once (tests).
 */
function webCommand(): Command {
  return new Command()
    .name('dsh --profile web')
    .description('Serve the DeepSeek Harness browser UI.')
    .helpOption('-h, --help', 'show this help')
    .option('--host <host>', 'bind address: one concrete IPv4 or IPv6 literal of a local interface, or 0.0.0.0 to bind all interfaces')
    .option('--no-open', 'do not open the Web UI in the default browser')
    .option('--port <port>', 'listen port; pass 0 to let the OS pick a free one')
    .option('--public-url <url>', 'advertise this HTTP(S) root in the printed, opened, web-surface, and DSH_WEB_URL forms; grants no trust')
    .option('--trusted-host <authority...>', 'extra authority the /api browser-trust fence accepts (host or host:port; repeatable)')
    .option('--no-browser-auth', 'skip the launch-token handshake; only for a deployment something else already authenticates')
    .option('--tls-cert <file>', 'PEM server certificate chain; requires --tls-key')
    .option('--tls-key <file>', 'unencrypted PEM private key; requires --tls-cert')
    .addHelpText('after', `
Examples:
  dsh --profile web                          serve on the composed host and port
  dsh --profile web --no-open                serve without opening a browser
  dsh --profile web --port 8080              serve on another port
  dsh --profile web --host 10.0.0.7          bind one local interface address
  dsh --profile web --host 0.0.0.0           bind all interfaces (LAN / reverse proxy);
                                             browsers must still pass the /api trust fence
  dsh --profile web --host 0.0.0.0 \\
    --trusted-host dsh.example.com           accept a reverse proxy's forwarded host
  dsh --profile web --no-browser-auth        trust an upstream proxy's own authentication
  dsh --profile web --public-url https://app.example/ui/ --trusted-host app.example
                                             advertise a prefix-stripping HTTPS proxy entry and admit its authority
  dsh --profile web --tls-cert ./server-chain.pem --tls-key ./server-key.pem
                                             serve HTTPS with an existing certificate and key
`)
}

/**
 * LAN authorities a wildcard bind is reachable by.
 *
 * A wildcard listener's own bind literal is `0.0.0.0`, which never appears as
 * a `Host`, so the fence's bind-address rule contributes nothing and a browser
 * dialing the machine's LAN address would be refused. Derive one port-less
 * IPv4 literal per non-internal interface — DNS rebinding needs an
 * attacker-controlled name, while an IP-literal Host is safe on any port.
 * @param host - the invocation's `--host`, when it named one.
 * @returns the derived authorities, or none for a concrete bind.
 */
function lanTrustAddresses(host: string | undefined): string[] {
  if (host === undefined || !isWildcardHost(host)) return []
  return Object.values(networkInterfaces()).flat()
    .filter((iface): iface is NonNullable<typeof iface> => iface !== undefined && iface.family === 'IPv4' && !iface.internal)
    .map(iface => iface.address)
}

/**
 * Parse and provide the Web invocation as an ordinary Cordis service. The
 * command's action publishes the flags this invocation named; `--host 0.0.0.0`
 * is accepted (binding all interfaces, e.g. behind a LAN reverse proxy; the
 * /api browser-trust fence still requires a loopback, derived LAN, or
 * declared `--trusted-host` authority), and a non-numeric `--port` or a
 * malformed `--public-url` is a usage error. `--no-browser-auth` clears
 * `browserAuth` for an invocation whose visitors an upstream proxy already
 * authenticates. Invalid flags, including an unpaired TLS certificate or key,
 * are usage errors. On rejection (and on `--help`) nothing is provided.
 * @param ctx - plugin context carrying the command line.
 */
export function apply(ctx: Context): void {
  const program = webCommand()
  program.action(() => {
    const options = program.opts<WebOptions>()
    if (options.port !== undefined && !/^\d+$/.test(options.port)) {
      program.error(`error: --port must be a number, got ${JSON.stringify(options.port)}`)
    }
    let tls: TlsConfig | undefined
    if (options.tlsCert !== undefined && options.tlsKey !== undefined) {
      tls = { certFile: options.tlsCert, keyFile: options.tlsKey }
    } else if (options.tlsCert !== undefined || options.tlsKey !== undefined) {
      program.error('error: --tls-cert and --tls-key must be supplied together')
    }
    if (options.publicUrl !== undefined) {
      try {
        parsePublicUrl(options.publicUrl, '--public-url')
      } catch (error) {
        program.error(`error: ${(error as Error).message}`)
      }
    }
    ctx.provide(WEB_STARTUP_SERVICE, {
      openBrowser: options.open,
      ...options.host !== undefined && { host: options.host },
      ...options.port !== undefined && { port: Number(options.port) },
      ...options.publicUrl !== undefined && { publicUrl: options.publicUrl },
      ...tls !== undefined && { tls },
      trustedHosts: [...lanTrustAddresses(options.host), ...options.trustedHost ?? []],
      browserAuth: options.browserAuth,
    } satisfies WebStartupValues)
  })
  parseCmdline(ctx, program)
}
