// HCP Terraform API のうち、この action が使う 2 つだけ (run の plan と plan ログ)。
// hcp-terraform-plan/src/tfc.ts にも同等のクライアントがあるが、action ごとに自己完結させる方針で共有しない

export type PlanSummary = {
  hasChanges: boolean
  additions: number
  changes: number
  destructions: number
  logReadUrl: string | null
}

export type PlanReader = {
  // run の plan を返す。plan が存在しない (run が plan 前に失敗した等) 場合は null
  getPlanForRun(runId: string): Promise<PlanSummary | null>
  // log-read-url (署名付きの一時 URL。認証ヘッダなし) の中身を返す
  fetchLog(url: string): Promise<string>
}

type PlanDocument = {
  data: {
    attributes: {
      'has-changes': boolean
      'resource-additions': number | null
      'resource-changes': number | null
      'resource-destructions': number | null
      'log-read-url'?: string | null
    }
  }
}

export class TfcClient implements PlanReader {
  constructor(
    private readonly hostname: string,
    private readonly token: string,
    private readonly fetchFn: typeof fetch = fetch
  ) {}

  async getPlanForRun(runId: string): Promise<PlanSummary | null> {
    const path = `/runs/${encodeURIComponent(runId)}/plan`
    const response = await this.fetchFn(`https://${this.hostname}/api/v2${path}`, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/vnd.api+json',
      },
    })
    if (response.status === 404) {
      return null
    }
    if (!response.ok) {
      throw new Error(
        `HCP Terraform API request failed: GET ${path} -> ${response.status} ${response.statusText}`
      )
    }
    const { data } = (await response.json()) as PlanDocument
    return {
      hasChanges: data.attributes['has-changes'],
      additions: data.attributes['resource-additions'] ?? 0,
      changes: data.attributes['resource-changes'] ?? 0,
      destructions: data.attributes['resource-destructions'] ?? 0,
      logReadUrl: data.attributes['log-read-url'] ?? null,
    }
  }

  async fetchLog(url: string): Promise<string> {
    const response = await this.fetchFn(url)
    if (!response.ok) {
      throw new Error(`Failed to fetch plan log: ${response.status} ${response.statusText}`)
    }
    return response.text()
  }
}
