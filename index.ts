import * as k8s from "@pulumi/kubernetes";
import * as random from "@pulumi/random";
import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";
import * as pulumi from "@pulumi/pulumi";
import * as docker from "@pulumi/docker";
import JitsuServerScaler from "./server-hpa";


const config = new pulumi.Config()
const firebaseCredentialsContent = config.require("firebaseCredentials")
const redisPort = 6379;


const devZone = aws.route53.getZone({
  name: "lottiefiles.dev",
})

const alb = aws.elb.getLoadBalancer({
  name: "a85d0f934a6e6424f8f4fc00e82751d5", // eks main load balancer
})

const devEKSCluster = aws.eks.getCluster({
  name: "eks_lottiefiles_dev"
});

const vpc =  awsx.ec2.Vpc.fromExistingIds("eks-vpc", {
  vpcId: devEKSCluster.then((c) => c.vpcConfig.vpcId),
})

// get all private subnets to allow access to redis cluster
// from EKS pods
const privateCIDRBlocks = devEKSCluster.then(async (c) => {
  const subnetResult = await aws.ec2.getSubnets({
    filters: [
      { name: "vpc-id", values: [c.vpcConfig.vpcId]},
      { name: "state", values: ["available"]},
    ]
  })

  const vpcSubnets = await Promise.all(subnetResult.ids.map(async (id) => {
    const subnet = await aws.ec2.getSubnet({
      id: id,
    })


    return subnet
  }))

  return vpcSubnets.filter((s) => !s.mapPublicIpOnLaunch).map((s) => s.cidrBlock);
})

const redisSg = new awsx.ec2.SecurityGroup("jitsu-redis-ingress", { vpc })

awsx.ec2.SecurityGroupRule.ingress(
  `jitsu-redis-access-from-nodes-to-private-blocks`, 
  redisSg, 
  { cidrBlocks: privateCIDRBlocks}, 
  new awsx.ec2.TcpPorts(redisPort)
)

// setup redis cluster 
const redisSubnetGroup = new aws.elasticache.SubnetGroup("jitsu-redis-subnet-group", {
  subnetIds: devEKSCluster.then(c => c.vpcConfig.subnetIds)
})

const redisInstance = new aws.elasticache.Cluster("jitsu-redis", {
  engine: "redis",
  engineVersion: "6.x",
  nodeType: "cache.t4g.small",
  numCacheNodes: 1,
  parameterGroupName: "default.redis6.x",
  port: redisPort,
  subnetGroupName: redisSubnetGroup.name,
  securityGroupIds: [redisSg.id]
})


// setup Jitsu Server and Configurator
const jitsuNS = new k8s.core.v1.Namespace("events-jitsu", { 
  metadata: {
    name: "events-jitsu"
  }
})

const jitsuConfiguratorLabels = {
  "stack": "telemetry",
  "subStack": "events",
  "component": "ingestor-configurator"
}

const jitsuServerLabels = {
  "stack": "telemetry",
  "subStack": "events",
  "component": "ingestor-api"
}

const clusterAdminToken = new random.RandomString("jitsu-cluster-admin-token", {
  length: 25,
  special: false,
});

const configuratorDNSRecord = new aws.route53.Record("jitsu-configurator-dns-record", {
  name: "config-events",
  type: aws.route53.RecordTypes.A,
  aliases: [
    {
      name: alb.then(l => l.dnsName),
      zoneId: alb.then(l => l.zoneId),
      evaluateTargetHealth: true,
    }
  ],
  zoneId: devZone.then((z) => z.zoneId)
})

const jitsuServerDNSRecord = new aws.route53.Record("jitsu-server-dns-record", {
  name: "publish-events",
  type: aws.route53.RecordTypes.A,
  aliases: [
    {
      name: alb.then(l => l.dnsName),
      zoneId: alb.then(l => l.zoneId),
      evaluateTargetHealth: true,
    }
  ],
  zoneId: devZone.then((z) => z.zoneId)
})

const configuratorFrontendImageECR = new aws.ecr.Repository("jitsu-configurator-frontend-ecr", {})

// Get registry info (creds and endpoint).
const imageName = pulumi.interpolate`${configuratorFrontendImageECR.repositoryUrl}:v0.0.1`;
const registryInfo = configuratorFrontendImageECR.registryId.apply(async id => {
  const credentials = await aws.ecr.getCredentials({ registryId: id });
  const decodedCredentials = Buffer.from(credentials.authorizationToken, "base64").toString();
  const [username, password] = decodedCredentials.split(":");
  if (!password || !username) {
    throw new Error("Invalid credentials");
  }
  return {
    server: credentials.proxyEndpoint,
    username: username,
    password: password,
  };
});

const firebaseConfig = `{"apiKey":"AIzaSyB_TlbrTYxxSfwGOxp8FdVDGsTTIyBL1HQ","authDomain":"jitsu-configurator.firebaseapp.com","projectId":"jitsu-configurator","storageBucket":"jitsu-configurator.appspot.com","messagingSenderId":"633641983642","appId":"1:633641983642:web:53694680ecd0c414d6c923"}`

const configuratorFrontendImage = new docker.Image("configurator-frontend", {
  imageName: imageName,
  registry: registryInfo,
  build: {
    context: "frontend",
    args: {
      "firebase_config": firebaseConfig,
    },
    env: {
      "DOCKER_BUILDKIT": "1"
    }
  }
})

const configuratorSvc =  new k8s.core.v1.Service("jitsu-configurator", {
  metadata: {
    namespace: jitsuNS.metadata.name,
  },
  spec: {
    selector: jitsuConfiguratorLabels,
    ports: [{
      name: "configurator",
      port: 80,
      targetPort: "configurator"
    }],
    type: "ClusterIP"
  }
})

const configuratorIngress = new k8s.networking.v1.Ingress("jitsu-configurator-ingress", {
  metadata: {
    name: "jitsu-configurator",
    namespace: jitsuNS.metadata.name,
    annotations: {
      "kubernetes.io/ingress.class": "nginx",
    },
  },
  spec: {

    rules: [
      {
        host: configuratorDNSRecord.fqdn,
        http: {
          paths: [
            {
              backend: {
                service: {
                  name: configuratorSvc.metadata.name,
                  port: {
                    name: "configurator"
                  }
                }
              },
              path: "/",
              pathType: "Prefix"
            }
          ]
        }
      }
    ],
    tls: [
      {
        hosts: [
          configuratorDNSRecord.fqdn
        ],
        secretName: "letsencrypt-lottie-dev"
      }
    ]
  }
})


const jitsuServerSvc = new k8s.core.v1.Service("jitsu-server", {
  metadata: {
    namespace: jitsuNS.metadata.name,
  },
  spec: {
    selector: jitsuServerLabels,
    ports: [{
      name: "jitsu-server",
      port: 80,
      targetPort: "server"
    }],
    type: "ClusterIP"
  }
})

const jitsuServerIngress = new k8s.networking.v1.Ingress("jitsu-server-ingress", {
  metadata: {
    name: "jitsu-server",
    namespace: jitsuNS.metadata.name,
    annotations: {
      "kubernetes.io/ingress.class": "nginx",
    },
  },
  spec: {

    rules: [
      {
        host: jitsuServerDNSRecord.fqdn,
        http: {
          paths: [
            {
              backend: {
                service: {
                  name: jitsuServerSvc.metadata.name,
                  port: {
                    name: "jitsu-server"
                  }
                }
              },
              path: "/",
              pathType: "Prefix"
            }
          ]
        }
      }
    ],
    tls: [
      {
        hosts: [
          jitsuServerDNSRecord.fqdn
        ],
        secretName: "letsencrypt-lottie-dev"
      }
    ]
  }
})


const firebaseCredentialsSecret = new k8s.core.v1.Secret("firebase-credentials", {
  metadata: {
    name: "jitsu-configurator-auth-firebase-credential",
    namespace: jitsuNS.metadata.name,
  },
  data: {
    "credentials.json": Buffer.from(firebaseCredentialsContent).toString("base64"),
  }
})

// Configurator document lives here:
// https://jitsu.com/docs/deployment/deploy-with-docker/jitsu-configurator
new k8s.apps.v1.Deployment("jitsu-configurator", {
  metadata: {
    namespace: jitsuNS.metadata.name,
  },
  spec: {
    selector: {
      matchLabels: jitsuConfiguratorLabels,
    },
    replicas: 2,
    template: {
      metadata: { 
        namespace: jitsuNS.metadata.name,
        labels: jitsuConfiguratorLabels,
      },
      spec: {
        volumes: [
          {
            name: "firebase-credentials",
            secret: {
              secretName: firebaseCredentialsSecret.metadata.name,
            }
          },
          {
            name: "jitsu-configurator-frontend",
            emptyDir: {},
          }
        ],
        initContainers: [
          {
            name: "jitsu-configurator-frontend",
            image: imageName,
            command: [
              "sh", "-c", "cp -r /app/web/* /frontend/",
            ],
            volumeMounts: [
              {
                mountPath: "/frontend",
                name: "jitsu-configurator-frontend",
              }
            ]
          },
        ],
        containers: [
          {
            name: "jitsu-configurator",
            image: "jitsucom/configurator",
            volumeMounts: [
              {
                name: "firebase-credentials",
                readOnly: true,
                mountPath: "/firebase"
              },
              {
                name: "jitsu-configurator-frontend",
                // Mount volume to frontend files path as in here:
                // https://github.com/jitsucom/jitsu/blob/89d9e170d92e93372aeca3307d0eb2f311f28db0/configurator-release.Dockerfile#L52
                mountPath: "/home/configurator/app/web/"
              }
            ],
            env: [
              { name: "CLUSTER_ADMIN_TOKEN", value: pulumi.interpolate`${clusterAdminToken.result}` },
              { name: "REDIS_URL", value: pulumi.interpolate`redis://${redisInstance.cacheNodes[0].address}` },
              { name: "JITSU_SERVER_URL", value: pulumi.interpolate`http://${jitsuServerSvc.metadata.name}.${jitsuNS.metadata.name}.svc.cluster.local` },

              // Firebase auth is not documented, best source for this is the code
              // https://github.com/jitsucom/jitsu/blob/d54aca60f2793882e9fc4a1274fc3348d68ac2ea/configurator/backend/authorization/service.go#L38
              //
              // Jitsu supports env palceholders in the config as well as automatic env with `_` as in place of `.` for nested values
              // https://github.com/jitsucom/jitsu/blob/d54aca60f2793882e9fc4a1274fc3348d68ac2ea/server/appconfig/reader.go#L85
              //
              // Relevant config properties
              // - auth.firebase.project_id
              // - auth.firebase.credentials_file
              // - auth.admin_domain
              // - auth.admin_users
              //
              { name: "AUTH_FIREBASE_PROJECT_ID", value: `jitsu-configurator` },
              { name: "AUTH_FIREBASE_CREDENTIALS_FILE", value: `/firebase/credentials.json` },
              { name: "AUTH_ADMIN_DOMAIN", value: `lottiefiles.com` },
              { name: "AUTH_ADMIN_USERS", value: `` },
            ],
            ports: [
              {
                containerPort: 7000,
                name: "configurator"
              }
            ]
          }
        ]
      }
    }
  }
})

// Jitsu server configuration document lives here:
// https://jitsu.com/docs/deployment/deploy-with-docker/jitsu-server
const jitsuDeployment = new k8s.apps.v1.Deployment("jitsu-server", {
  metadata: {
    namespace: jitsuNS.metadata.name,
  },
  spec: {
    selector: {
      matchLabels: jitsuServerLabels,
    },
    replicas: 2,
    template: {
      metadata: { 
        labels: jitsuServerLabels,
        namespace: jitsuNS.metadata.name,
      },
      spec: {
        containers: [{
          name: "jitsu-server",
          image: "jitsucom/server",
          env: [
            { name: "SERVER_PORT", value: "8080" },
            { name: "CLUSTER_ADMIN_TOKEN", value: pulumi.interpolate`${clusterAdminToken.result}` },
            { name: "REDIS_URL", value: pulumi.interpolate`redis://${redisInstance.cacheNodes[0].address}` },
            { name: "JITSU_CONFIGURATOR_URL", value: pulumi.interpolate`http://${configuratorSvc.metadata.name}.${jitsuNS.metadata.name}.svc.cluster.local` },
          ],
          ports: [
            {
              name: "server",
              containerPort: 8080,
            }
          ]
        }]
      }
    }
  }
})

// Not supported in current version
//
// new JitsuServerScaler("jitsu-pod-scaler", {
//   target: {
//     name: jitsuDeployment.metadata.name,
//     kind: "Deployment",
//   }
// })

export const namespace = jitsuNS.metadata.name;
export const redisEndpoint = pulumi.interpolate`${redisInstance.cacheNodes[0].address}`;
export const configuratorURL = pulumi.interpolate`https://${configuratorDNSRecord.fqdn}`;
export const serverURL = pulumi.interpolate`https://${jitsuServerDNSRecord.fqdn}`;
