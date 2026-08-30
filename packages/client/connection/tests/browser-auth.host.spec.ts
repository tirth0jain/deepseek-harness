/** No-op browser-session authenticator behavior (authentication disabled). */

import { describe, expect, it } from 'vitest'
import { BrowserAuth } from '../src/browser-auth.ts'
import type { ConnectionIndexRequest, ConnectionIndexResponse } from '../src/rpc.ts'

interface ResponseState {
  status?: number
  headers?: Readonly<Record<string, string>>
  body?: string
}

function response(): { value: ConnectionIndexResponse; state: ResponseState } {
  const state: ResponseState = {}
  return {
    value: {
      writeHead(status, headers) {
        state.status = status
        if (headers !== undefined) state.headers = headers
      },
      end(body) {
        if (body !== undefined) state.body = body
      },
    },
    state,
  }
}

function request(url: string, authority = '127.0.0.1:3080', init?: {
  cookie?: string
  method?: string
}): ConnectionIndexRequest {
  return {
    method: init?.method ?? 'GET',
    url,
    headers: {
      host: authority,
      ...init?.cookie === undefined ? {} : { cookie: init.cookie },
    },
  }
}

describe('BrowserAuth', () => {
  it('mints no launch token and returns the clean URL unchanged', async () => {
    const auth = await BrowserAuth.create()
    expect(auth.authenticatedUrl('http://127.0.0.1:3080')).toBe('http://127.0.0.1:3080')
    expect(auth.authenticatedUrl('http://192.168.1.5:39123')).toBe('http://192.168.1.5:39123')
    expect(new URL(auth.authenticatedUrl('http://127.0.0.1:3080')).search).toBe('')
  })

  it('admits every index request without writing a redirect or a cookie', async () => {
    const auth = await BrowserAuth.create()
    for (const candidate of [
      request('/'),
      request('/?token=anything'),
      request('/index.html'),
      request('/?token=wrong&token=again'),
      request('/', 'localhost:3080'),
      request('/', 'harness.example'),
      request('/', '127.0.0.1:3080', { method: 'HEAD' }),
      request('/', '127.0.0.1:3080', { cookie: 'dsh-auth-test=v1.whatever' }),
    ]) {
      const res = response()
      expect(auth.authorizeIndex(candidate, res.value)).toBe(true)
      expect(res.state).toEqual({})
    }
  })

  it('reports every browser as authenticated regardless of headers', async () => {
    const auth = await BrowserAuth.create()
    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080'))).toBe(true)
    expect(auth.isAuthenticated({ headers: {} })).toBe(true)
    expect(auth.isAuthenticated({ headers: { host: 'bad host' } })).toBe(true)
    expect(auth.isAuthenticated({
      headers: new Headers({ host: '127.0.0.1:3080', cookie: 'dsh-auth-test=broken' }),
    })).toBe(true)
  })
})
