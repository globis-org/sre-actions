// HCP Terraform API のうち、この action が使う 3 つだけ (run の plan、plan ログ、redacted JSON plan)。
// hcp-terraform-plan/src/tfc.ts にも同等のクライアントがあるが、action ごとに自己完結させる方針で共有しない

export type PlanSummary = {
  id: string
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
  // terraform show -json 相当の JSON plan (sensitive な値はハッシュ化済み) を返す
  fetchRedactedPlan(planId: string): Promise<string>
}

type PlanDocument = {
  data: {
    id: string
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

  private get(path: string, redirect: RequestInit['redirect'] = 'follow'): Promise<Response> {
    return this.fetchFn(`https://${this.hostname}/api/v2${path}`, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/vnd.api+json',
      },
      redirect,
    })
  }

  async getPlanForRun(runId: string): Promise<PlanSummary | null> {
    const path = `/runs/${encodeURIComponent(runId)}/plan`
    const response = await this.get(path)
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
      id: data.id,
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

  // json-output-redacted は API ドキュメントに無いが、Terraform CLI が Structured Run Output の描画に
  // 使っている endpoint。runs の read 権限で取れる (文書化されている json-output は admin が必要)。
  // 307 で署名付き URL に誘導されるので、認証ヘッダを付けずにそちらを取る
  async fetchRedactedPlan(planId: string): Promise<string> {
    const path = `/plans/${encodeURIComponent(planId)}/json-output-redacted`
    const response = await this.get(path, 'manual')
    const location = response.headers.get('location')
    if (response.status !== 307 || location === null) {
      throw new Error(
        `HCP Terraform API request failed: GET ${path} -> ${response.status} ${response.statusText}`
      )
    }
    return this.fetchLog(location)
  }
}
