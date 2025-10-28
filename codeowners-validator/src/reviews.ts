export type ListReviewsParams = {
  owner: string
  repo: string
  pull_number: number
}

type ListReviewsMethod = (
  params: ListReviewsParams & {
    page?: number
    per_page?: number
  }
) => Promise<{
  data: PullRequestReview[]
}>

export type OctokitListReviewsClient = {
  paginate: (
    method: ListReviewsMethod,
    params: ListReviewsParams & { per_page?: number },
    mapFn?: unknown
  ) => Promise<PullRequestReview[]>
  rest: {
    pulls: {
      listReviews: ListReviewsMethod
    }
  }
}

export type PullRequestReview = {
  state: string
  user?: {
    login?: string | null
  } | null
}

export const listAllReviews = async (
  octokit: OctokitListReviewsClient,
  params: ListReviewsParams
) => {
  // GitHub REST API は per_page のデフォルトが 30 かつ 1 ページ目のみの返却なので
  // ページネーションを明示指定して全レビューを回収する。
  return octokit.paginate(octokit.rest.pulls.listReviews, {
    ...params,
    per_page: 100,
  })
}

export const collectApprovers = (reviews: PullRequestReview[]) =>
  reviews
    .filter(review => review.state === 'APPROVED')
    .flatMap(review => review.user?.login ?? [])
