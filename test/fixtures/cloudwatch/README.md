# Synthetic CloudWatch contract fixtures

These records are hand made and contain no account data. Their field shapes
follow the AWS `GetMetricData` and `GetQueryResults` response models in the
[CloudWatch API reference](https://docs.aws.amazon.com/AmazonCloudWatch/latest/APIReference/API_GetMetricData.html)
and [CloudWatch Logs API reference](https://docs.aws.amazon.com/AmazonCloudWatchLogs/latest/APIReference/API_GetQueryResults.html).
The adapter test converts the metric timestamp string to a `Date`, matching
the AWS SDK's decoded response type.
