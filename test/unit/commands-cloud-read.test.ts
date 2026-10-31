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
    "gsutil ls gs://bucket", "gcloud compute instances list", "az vm list", "ansible-playbook site.yml --syntax-check", "ansible-playbook --list-hosts site.yml",
    "kubectl cluster-info", "kubectl cluster-info dump", "terraform providers schema -json",
    "az webapp log tail --name web -g rg", "gcloud storage ls gs://bucket", "gcloud events triggers list", "az search service show --name s1 -g rg",
    "az graph shared-query list -g rg", "gcloud logging logs list",
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
    // A group whose name is a read word ("search", "events", "graph", "logs", "plan") is not the verb (second round).
    ["az search service delete --name s1 --resource-group rg --yes", "Deletes something in Azure."],
    ["az search service create --name s1 -g rg --sku basic", "Changes Azure."],
    ["az search admin-key renew --service-name s1 -g rg --key-kind primary", "Changes Azure."],
    ["gcloud events triggers delete my-trigger", "Deletes something in Google Cloud."],
    ["az graph shared-query delete --name q1 -g rg", "Deletes something in Azure."],
    ["gcloud logging logs delete my-log", "Deletes something in Google Cloud."],
    ["az appservice plan create --name p1 -g rg", "Changes Azure."],
    // A check run, a dump to a folder and a providers mirror or lock are not reads (second round).
    ["ansible-playbook --check site.yml", "Ember can't tell whether this changes the managed computers."],
    ["ansible-playbook -C site.yml", "Ember can't tell whether this changes the managed computers."],
    ["terraform providers mirror /tmp/x", "Downloads the providers this folder's configuration uses."],
    ["terraform providers lock -platform=linux_amd64", "Downloads the providers this folder's configuration uses."],
  ])("asks for %j, saying %j", (cmd, line) => {
    const d = decide(cmd);
    expect(d.verdict).toBe("ask");
    expect(d.says).toContain(line);
  });

  it("judges where `kubectl cluster-info dump` writes, like any other write", () => {
    expect(decide("kubectl cluster-info dump --output-directory=/home/ana/.ssh").verdict).toBe("ask");
    expect(decide("kubectl cluster-info dump --output-directory /home/ana/.ssh").verdict).toBe("ask");
    expect(decide("kubectl cluster-info dump --output-directory=/home/ana/.config/ember").verdict).toBe("refuse");
    expect(decide('kubectl cluster-info dump --output-directory="$D"').verdict).toBe("ask");
  });
});
