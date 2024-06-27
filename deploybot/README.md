# aws-ssm-parameter action

This action notifies the workflow status to Slack.

## How to use

```yaml
    steps:
      - name: Notify job status
        uses: globis-org/sre-actions/deploybot@6ba129bd5600ddc8365a235c9737fcbf125b758d # v1
        with:
          type: docker
          status: ${{ job.status }}
          token: ${{ secrets.SLACK_OAUTH_TOKEN }}
          channel: ${{ env.SLACK_CHANNEL }}
          custom_fields: |
            - title: Tags
              value: "```${{ env.IMAGE_TAG }}\n${{ env.LATEST_TAG }}```"
        if: always()
```
