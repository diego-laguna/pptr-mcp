# Infrastructure (AWS CDK)

Two stacks: `CatalogScrape` (queues, bucket, scrape worker, scheduler) and `CatalogDiscovery` (Fargate discovery workers).

## Test the stacks locally with aws-emulator

```sh
pnpm local:deploy    # starts aws-emulator if needed, synthesizes, deploys both stacks, checks key resources
pnpm local:destroy   # deletes both stacks
```

`local:deploy` synthesizes with `-c local=true`, which:
- replaces the worker Docker image (Lambda) with an inline stub handler and the discovery container with a public busybox image, so no image build or registry is needed;
- pins account `000000000000` / `us-east-1` and the availability zones, so synth needs no AWS credentials.

It verifies that the stacks deploy and the expected resources exist. It does not run the worker code. Requires `aws-emulator` and the AWS CLI on `PATH`; the emulator serves HTTPS on port 9297 (override with `EMULATOR_DATA_PORT`).
