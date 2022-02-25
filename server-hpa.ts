import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

interface JitsuServerScalerArgs {
  target: {
    name: pulumi.Input<string>;
    kind: pulumi.Input<string>;
  }
}

class JitsuServerScaler extends pulumi.ComponentResource {
  public readonly scaler: k8s.autoscaling.v2.HorizontalPodAutoscaler;

  constructor(name: string, args: JitsuServerScalerArgs, opts?: pulumi.CustomResourceOptions) {
    super("jitsu-server-scaler", name, opts)

    const scaler = new k8s.autoscaling.v2.HorizontalPodAutoscaler("jitsu-server-scaler", {
      metadata: {
        namespace: "todo-replace",
      },
      spec: {
        maxReplicas: 10,
        minReplicas: 2,
        scaleTargetRef: args.target,
        metrics: [
          {
            pods: {
              metric: {
                name: "packets-per-second",
              },
              target: {
                type: "AverageValue",
                averageValue: "1k",
              },
            },
            type: "Pods",
          },
        ]
      },
    })

    this.scaler = scaler;
  }
}


export default JitsuServerScaler;
