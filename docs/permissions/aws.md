# AWS CloudWatch read access

For IAM role, policy-simulation, and Access Analyzer reads, use the separate
[IAM permission guide](iam.md).

Enable CloudWatch with a named profile in a private credentials file. The file
must be owned by the current user and have no group or other permissions. The
file must contain only the named profile with `aws_access_key_id`,
`aws_secret_access_key`, and optionally `aws_session_token`. Source profiles,
credential processes, SSO, and default credential-chain fallback are refused.
Do not use an administrator profile. A disabled CloudWatch provider does not
load AWS credentials.

The profile needs `cloudwatch:GetMetricData`, `cloudwatch:DescribeAlarms`,
`logs:DescribeLogGroups`, `logs:StartQuery`, `logs:GetQueryResults`, and
`logs:StopQuery`. `GetCallerIdentity` identifies the caller; an assumed role also
needs `iam:GetRole` to verify the role. Startup calls
`iam:SimulatePrincipalPolicy` for selected write actions and refuses a positive
or incomplete result. Scope log permissions to the private log-group allowlist
where AWS supports resource scoping. The exact policy must be prepared for the
target account and reviewed there; no account-specific policy belongs in this
repository.

This policy template lists the adapter's actions. Replace every `${...}` value
in a private copy, remove the unused IAM principal type, and review the
resulting resource scope before attaching it. The template uses `Resource: "*"`
for metric reads, composite alarm listing, log-group listing, and stopping a
query; the query read is limited to the configured log group. Tighten those
scopes where the target account and API support it.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["cloudwatch:GetMetricData", "cloudwatch:DescribeAlarms", "logs:DescribeLogGroups", "logs:StopQuery"],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": ["logs:StartQuery", "logs:GetQueryResults"],
      "Resource": "arn:aws:logs:${REGION}:${ACCOUNT_ID}:log-group:${LOG_GROUP}:*"
    },
    {
      "Effect": "Allow",
      "Action": "iam:GetRole",
      "Resource": "arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}"
    },
    {
      "Effect": "Allow",
      "Action": "iam:SimulatePrincipalPolicy",
      "Resource": [
        "arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}",
        "arn:aws:iam::${ACCOUNT_ID}:user/${USER_NAME}"
      ]
    }
  ]
}
```

The [CloudWatch Logs authorization reference](https://docs.aws.amazon.com/service-authorization/latest/reference/list_logs.html),
the [CloudWatch authorization reference](https://docs.aws.amazon.com/service-authorization/latest/reference/list_cloudwatch.html),
and the [IAM simulator API reference](https://docs.aws.amazon.com/IAM/latest/APIReference/API_SimulatePrincipalPolicy.html)
are the sources for resource-level support and simulation behavior.

The simulation checks representative IAM, Logs, Lambda, and CloudFormation
write actions. It is a fail-closed startup gate for those actions, not a proof
that every AWS write permission has been enumerated. The operator must also
issue a read-scoped policy and verify it independently before live use.

For Logs Insights, configure `maxLogWindowMinutes` and `maxScanBytes`. The
defaults are 60 minutes and 5 MB, with a hard 24-hour window maximum. A query
must end in `| limit N` where N is at most 1,000 and no more than the global
row cap. The provider reports returned rows, scanned records, and scanned bytes.
If the scan exceeds the configured cap, the tool refuses and calls `StopQuery`.
CloudWatch reports scan statistics after query execution begins, so the cap is
enforced at the first observed statistic rather than as a preflight estimate.
