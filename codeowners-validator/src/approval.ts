export type FileRequiredUsers = {
  filename: string
  requiredUsers: string[]
}

export type ApprovalResult =
  | { approved: true; approvedBy: string[] }
  | { approved: false; unapprovedFiles: string[] }

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
