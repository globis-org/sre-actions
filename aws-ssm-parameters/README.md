# aws-ssm-parameter action

This action gets ssm parameters and set them as environment variables in workflow

## How to use

```yaml
    steps:
      - name: Configure AWS Credentials
        uses: aws-actions/configure-aws-credentials@v1
        with:
          role-to-assume: ${{ env.ROLE_TO_ASSUME }}
          aws-region: ap-northeast-1

      - name: Set parameters to env vars
          uses: globis-org/sre-actions/aws-ssm-parameters@6ba129bd5600ddc8365a235c9737fcbf125b758d # v1
          with:
            data: |
              - key: /dev/parameter-a
                name: PARAMETER_A
              - key: /dev/parameter-b
                name: PARAMETER_B
```