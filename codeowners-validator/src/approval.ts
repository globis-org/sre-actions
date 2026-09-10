import type { FileOwners } from './parse'

export type FileRequiredUsers = {
  filename: string
  requiredUsers: string[]
}

export type ApprovalResult =
  | { approved: true; approvedBy: string[] }
  | { approved: false; unapprovedFiles: string[] }

// GitHub の review オブジェクトのうち承認判定に必要な項目だけを受け取る
export type Review = {
  state: string
  user: { login: string } | null
}

// GitHub 標準の CODEOWNERS と同じく、オーナーが設定されたファイルごとにそのオーナーの approve を要求する。
// 全ファイルのオーナーを合算して「誰か 1 人」で判定すると、権限の弱いオーナーの approve だけで
// 権限の強いオーナー専管のファイルまで通ってしまうため。
export const evaluateApprovals = (
  files: FileRequiredUsers[],
  approvers: string[]
): ApprovalResult => {
  const ownedFiles = files.filter(file => file.requiredUsers.length > 0)

  const unapprovedFiles = ownedFiles
    .filter(file => !file.requiredUsers.some(user => approvers.includes(user)))
    .map(file => file.filename)
  if (unapprovedFiles.length > 0) {
    return { approved: false, unapprovedFiles }
  }

  // オーナー未設定のファイルしかない場合は、誰かの approve があれば通す
  if (ownedFiles.length === 0 && approvers.length === 0) {
    return { approved: false, unapprovedFiles: [] }
  }

  const approvedBy = approvers.filter(approver =>
    ownedFiles.some(file => file.requiredUsers.includes(approver))
  )
  return { approved: true, approvedBy: [...new Set(approvedBy)] }
}

// オーナー (ユーザーまたはチーム) → ユーザー一覧の対応表から、ファイルごとに approve を出せるユーザーを組み立てる。
// ルールにマッチしたオーナーがユーザー 0 人に解決された場合は、オーナー未設定と区別できず fail-open になるため例外にする。
export const resolveRequiredUsers = (
  fileOwners: FileOwners[],
  usersByOwner: Map<string, string[]>
): FileRequiredUsers[] =>
  fileOwners.map(fileOwner => ({
    filename: fileOwner.filename,
    requiredUsers: [
      ...new Set(
        fileOwner.owners.flatMap(owner => {
          const users = usersByOwner.get(owner.name)
          if (!users || users.length === 0) {
            throw new Error(`Owner "${owner.name}" has no users to approve.`)
          }
          return users
        })
      ),
    ],
  }))

// GitHub の review 判定に合わせ、ユーザーごとの最新の review 状態が APPROVED の人を approver とする。
// COMMENTED は承認状態を変えないので無視し、CHANGES_REQUESTED や DISMISSED が後にあれば approve は取り消されたとみなす。
// reviews は API が返す時系列順で渡されることを前提とする。
export const listApprovers = (reviews: Review[]): string[] => {
  const latestStateByUser = new Map<string, string>()
  for (const review of reviews) {
    if (!review.user || review.state === 'COMMENTED' || review.state === 'PENDING') {
      continue
    }
    latestStateByUser.set(review.user.login, review.state)
  }
  return [...latestStateByUser].filter(([, state]) => state === 'APPROVED').map(([login]) => login)
}
