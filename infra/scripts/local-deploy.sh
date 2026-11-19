#!/usr/bin/env bash
# Deploys both stacks to a local aws-emulator and checks the key resources exist.
# Usage: pnpm local:deploy [--destroy]
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${EMULATOR_DATA_PORT:-9297}"
export AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_DEFAULT_REGION=us-east-1
export AWS_PAGER="" AWS_CA_BUNDLE="$HOME/.aws/emulator/$PORT/ca.pem"
export CDK_DEFAULT_ACCOUNT=000000000000 CDK_DEFAULT_REGION=us-east-1
ENDPOINT="https://127.0.0.1:$PORT"
OUT="$(mktemp -d)"
cfn() { aws --endpoint-url "$ENDPOINT" cloudformation "$@"; }

healthy() { curl -fsk -m 2 "$ENDPOINT/__admin/health" >/dev/null 2>&1; }
if ! healthy; then
  command -v aws-emulator >/dev/null || { echo "aws-emulator not found on PATH" >&2; exit 1; }
  echo "Starting aws-emulator on port $PORT (exits after 30 min idle)..."
  nohup aws-emulator -a off -t off -p "$PORT" --idle-timeout 1800 >"$OUT/emulator.log" 2>&1 &
  for _ in $(seq 1 30); do healthy && break; sleep 1; done
  healthy || { echo "emulator did not become healthy; log: $OUT/emulator.log" >&2; exit 1; }
fi
# The CA file is written on first start; the first health check may precede it on a cold run.
[ -f "$AWS_CA_BUNDLE" ] || { echo "missing CA bundle $AWS_CA_BUNDLE" >&2; exit 1; }

# CDK templates check the bootstrap version in SSM; fake one so the check passes without bootstrapping.
aws --endpoint-url "$ENDPOINT" ssm put-parameter --name /cdk-bootstrap/hnb659fds/version \
  --type String --value 30 --overwrite >/dev/null

STACKS=(CatalogScrape CatalogDiscovery)

if [ "${1:-}" = "--destroy" ]; then
  for ((i=${#STACKS[@]}-1; i>=0; i--)); do
    cfn delete-stack --stack-name "${STACKS[$i]}"
    cfn wait stack-delete-complete --stack-name "${STACKS[$i]}"
  done
  echo "Destroyed."; exit 0
fi

pnpm exec cdk synth -q -c local=true -o "$OUT/cdk.out" >/dev/null

for s in "${STACKS[@]}"; do
  echo "Deploying $s..."
  # Clear a leftover failed stack from a previous run; CloudFormation cannot update ROLLBACK_COMPLETE.
  status=$(cfn describe-stacks --stack-name "$s" --query 'Stacks[0].StackStatus' --output text 2>/dev/null || true)
  if [ "$status" = "ROLLBACK_COMPLETE" ] || [ "$status" = "CREATE_FAILED" ]; then
    cfn delete-stack --stack-name "$s"; cfn wait stack-delete-complete --stack-name "$s"
  fi
  if ! cfn deploy --stack-name "$s" --template-file "$OUT/cdk.out/$s.template.json" \
      --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM --no-fail-on-empty-changeset; then
    cfn describe-stack-events --stack-name "$s" \
      --query 'StackEvents[?contains(ResourceStatus,`FAILED`)].[LogicalResourceId,ResourceStatusReason]' --output text >&2
    exit 1
  fi
done

echo "Checking deployed resources..."
fail=0
check() { # description, command...
  local d="$1"; shift
  if "$@" >/dev/null 2>&1; then echo "  ok   $d"; else echo "  FAIL $d"; fail=1; fi
}
res() { cfn list-stack-resources --stack-name "$1" --query "StackResourceSummaries[?ResourceType=='$2'] | length(@)" --output text; }
count_at_least() { [ "$(res "$1" "$2")" -ge "$3" ]; }
check "CatalogScrape: >=5 SQS queues"        count_at_least CatalogScrape AWS::SQS::Queue 5
check "CatalogScrape: S3 bucket"             count_at_least CatalogScrape AWS::S3::Bucket 1
check "CatalogScrape: worker Lambda"         count_at_least CatalogScrape AWS::Lambda::Function 1
check "CatalogScrape: scheduler group"       count_at_least CatalogScrape AWS::Scheduler::ScheduleGroup 1
check "CatalogDiscovery: ECS service"        count_at_least CatalogDiscovery AWS::ECS::Service 1
check "CatalogDiscovery: >=2 SQS queues"     count_at_least CatalogDiscovery AWS::SQS::Queue 2
[ "$fail" = 0 ] && echo "All stacks deployed locally." || exit 1
