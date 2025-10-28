import { collectApprovers, listAllReviews } from '../reviews'

type ListReviewsParams = Parameters<typeof listAllReviews>[1]
type OctokitListReviewsClient = Parameters<typeof listAllReviews>[0]
type PullRequestReview = Parameters<typeof collectApprovers>[0][number]

describe('listAllReviews', () => {
  it('performs pagination with maximum page size', async () => {
    const paginate = jest
      .fn<
        ReturnType<OctokitListReviewsClient['paginate']>,
        Parameters<OctokitListReviewsClient['paginate']>
      >()
      .mockResolvedValue([] as PullRequestReview[])
    const listReviews = jest
      .fn<
        ReturnType<OctokitListReviewsClient['rest']['pulls']['listReviews']>,
        Parameters<OctokitListReviewsClient['rest']['pulls']['listReviews']>
      >()
      .mockResolvedValue({ data: [] as PullRequestReview[] })

    const octokit: OctokitListReviewsClient = {
      paginate,
      rest: {
        pulls: {
          listReviews,
        },
      },
    }

    const params: ListReviewsParams = {
      owner: 'globis-org',
      repo: 'sre-actions',
      pull_number: 8316,
    }

    await listAllReviews(octokit, params)

    expect(paginate).toHaveBeenCalledWith(listReviews, {
      ...params,
      per_page: 100,
    })
  })
})

describe('collectApprovers', () => {
  it('collects approvers beyond the default page size', () => {
    const reviews: PullRequestReview[] = Array.from(
      { length: 68 },
      (_, index) => ({
        state: index === 35 ? 'APPROVED' : 'COMMENTED',
        user: {
          login: `reviewer-${index}`,
        },
      })
    )

    const approvers = collectApprovers(reviews)

    expect(approvers).toContain('reviewer-35')
  })
})
