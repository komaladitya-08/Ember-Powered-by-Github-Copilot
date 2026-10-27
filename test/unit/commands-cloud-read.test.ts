/**
 * Cloud and cluster command-line tools (design §3.5.2, review #30): the read-only commands a cloud engineer runs first
 * run without a card, the changes still ask, and a verb Ember doesn't know asks without claiming that it changes the
 * service.
 */

import { describe, expect, it } from "vitest";
import { runCase } from "../fixtures/commands/corpus";

const decide = (cmd: string) => runCase({ cmd, verdict: "run" }, { shell: "bash", context: "linux" }).decision;

describe("cloud and cluster reads (review #30)", () => {
  it.each([
    "aws s3 ls", "aws s3 ls s3://bucket/", "aws logs tail /aws/lambda/x", "aws ec2 describe-instances", "aws sts get-caller-identity",
    "terraform validate", "terraform output", "terraform fmt", "terraform show", "terraform state list", "terraform providers",
    "kubectl config current-context", "kubectl config get-contexts", "kubectl api-resources", "kubectl rollout status deploy/web",
    "kubectl rollout history deploy/web", "kubectl get pods -A", "helm repo list", "helm history web", "helm status web",
    "gsutil ls gs://bucket", "gcloud compute instances list", "az vm list", "ansible-playbook --check site.yml", "ansible-playbook site.yml --syntax-check",
  ])("runs %j", cmd => {
    expect(decide(cmd)).toMatchObject({ verdict: "run", says: [] });
  });

  it.each([
    ["kubectl apply -f deploy.yaml", "Changes Kubernetes."],
    ["kubectl rollout restart deploy/web", "Changes Kubernetes."],
    ["terraform apply", "Changes the infrastructure."],
    ["aws ec2 run-instances --image-id x", "Changes AWS."],
    ["aws s3 mb s3://new-bucket", "Changes AWS."],
    ["helm install web ./chart", "Changes Kubernetes."],
    ["ansible-playbook site.yml", "Changes the managed computers."],
    ["kubectl config use-context prod", "Ember can't tell whether this changes Kubernetes."],
    ["aws logs filter-log-events --log-group-name x", "Ember can't tell whether this changes AWS."],
    ["terraform init", "Installs the providers and modules this folder's configuration uses."],
  ])("asks for %j, saying %j", (cmd, line) => {
    const d = decide(cmd);
    expect(d.verdict).toBe("ask");
    expect(d.says).toContain(line);
  });
});
