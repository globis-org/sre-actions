export const actionRepoURL = 'https://github.com/globis-org/sre-actions'
export const githubIconURL =
  'https://images.zenhubusercontent.com/5ddf7e4a70febb0001f9d903/a95e1c1a-0a7f-4957-9fc5-75e8bec081f0'

export type Type = 'docker' | 'spa' | 'ansible' | 'unknown'
export type Phase = 'started' | 'success' | 'failure' | 'cancelled' | 'unknown'

export const getType = (raw: string): Type => {
  switch (raw) {
    case 'docker':
      return 'docker'
    case 'spa':
      return 'spa'
    case 'ansible':
      return 'ansible'
    default:
      return 'unknown'
  }
}

export const getPhase = (status: string): Phase => {
  switch (status.toLowerCase()) {
    case 'started':
      return 'started'
    case 'success':
    case 'succeeded':
      return 'success'
    case 'failure':
    case 'failed':
      return 'failure'
    case 'cancelled':
      return 'cancelled'
    default:
      return 'unknown'
  }
}

export const icons: Record<Phase, string> = {
  started: '',
  success: '',
  failure: '',
  cancelled: '',
  unknown: '',
}

export const usernames: Record<Phase, string> = {
  started: 'Deploy Bot (started)',
  success: 'Deploy Bot (success)',
  failure: 'Deploy Bot (failure)',
  cancelled: 'Deploy Bot (cancelled)',
  unknown: 'Deploy Bot (unknown)',
}

export const colors: Record<Phase, string> = {
  started: '#e9e9e9',
  success: '#18be52',
  failure: '#E96D76',
  cancelled: '#3b3b82',
  unknown: '#e9e9e9',
}

export const baseTexts: Record<Type, Record<Phase, string>> = {
  docker: {
    started: `:docker: ビルドが始まったよ`,
    success: `:white_check_mark: :docker: ビルドが成功したよ`,
    failure: `:exclamation: :docker: ビルドが失敗したよ`,
    cancelled: `:exclamation: :docker: ビルドがキャンセルされたよ`,
    unknown: `:exclamation: :docker: ビルドが...？`,
  },
  spa: {
    started: `:react: デプロイが始まったよ`,
    success: `:white_check_mark: :react: デプロイが成功したよ`,
    failure: `:exclamation: :react: デプロイが失敗したよ`,
    cancelled: `:exclamation: :react: デプロイがキャンセルされたよ`,
    unknown: `:exclamation: :react: デプロイが...？`,
  },
  ansible: {
    started: `:ansible: デプロイが始まったよ`,
    success: `:white_check_mark: :ansible: デプロイが成功したよ`,
    failure: `:exclamation: :ansible: デプロイが失敗したよ`,
    cancelled: `:exclamation: :ansible: デプロイがキャンセルされたよ`,
    unknown: `:exclamation: :ansible: デプロイが...？`,
  },
  unknown: {
    started: `ワークフローが始まったよ`,
    success: `:white_check_mark: ワークフローが成功したよ`,
    failure: `:exclamation: ワークフローが失敗したよ`,
    cancelled: `:exclamation: ワークフローがキャンセルされたよ`,
    unknown: `:exclamation: ワークフローが...？`,
  },
}
