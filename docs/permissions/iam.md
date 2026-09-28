# IAM read access

Enable the IAM provider only with an owner-only credentials file containing one
named static or temporary profile. The parser rejects default-chain fallback,
source profiles, credential processes, and SSO settings. Do not use an
administrator profile. Configure at most 20 exact role names and, optionally,
the ARN of one external-access analyzer. A disabled provider never reads the
credential file.

The provider calls only `sts:GetCallerIdentity`, `iam:ListRoles`, `iam:GetRole`,
`iam:ListAttachedRolePolicies`, `iam:GetPolicy`, `iam:GetPolicyVersion`,
`iam:SimulatePrincipalPolicy`, and `access-analyzer:ListFindings`. The STS call
does not require a separate IAM permission grant. Startup simulates selected
write actions and refuses an allowed or incomplete result. This check is not
an exhaustive proof of zero write access: issue and review a read-scoped policy
for the target account before live use.

Start from this policy shape in a private copy, replacing placeholders with
the configured account, roles, policies, and external analyzer. Review resource
scope against the target account before attaching it.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "iam:ListRoles",
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": ["iam:GetRole", "iam:ListAttachedRolePolicies"],
      "Resource": "arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}"
    },
    {
      "Effect": "Allow",
      "Action": "iam:SimulatePrincipalPolicy",
      "Resource": [
        "arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}",
        "arn:aws:iam::${ACCOUNT_ID}:user/${USER_NAME}"
      ]
    },
    {
      "Effect": "Allow",
      "Action": ["iam:GetPolicy", "iam:GetPolicyVersion"],
      "Resource": "${ATTACHED_POLICY_ARN}"
    },
    {
      "Effect": "Allow",
      "Action": "access-analyzer:ListFindings",
      "Resource": "arn:aws:access-analyzer:${REGION}:${ACCOUNT_ID}:analyzer/${EXTERNAL_ANALYZER_NAME}"
    }
  ]
}
```

Role and policy documents are parsed in memory. Tools return principal types,
whether trust conditions exist, whether an external ID is required, and policy
statement counts. They never return principal values, external-ID values,
condition values, or full policy documents. Simulation requires one configured
role, one action without wildcards, and one concrete resource ARN. Missing
context yields `unknown`, not a denial claim. The matched statement reference
combines AWS's source policy ID and document position; AWS does not return the
statement's `Sid` in the simulation result.

`ListFindings` reads an external-access analyzer. Other analyzer types require
`ListFindingsV2`, which this milestone does not allow. Finding output omits
resource, principal, and action details. See the [IAM simulator API](https://docs.aws.amazon.com/IAM/latest/APIReference/API_SimulatePrincipalPolicy.html)
and [Access Analyzer ListFindings API](https://docs.aws.amazon.com/access-analyzer/latest/APIReference/API_ListFindings.html).

No live IAM profile was supplied for this milestone. Local replay and SDK
command tests establish the implementation behavior, not live account access.
