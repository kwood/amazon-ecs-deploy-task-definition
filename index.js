const path = require('path');
const core = require('@actions/core');
const { 
  ECSClient, 
  RegisterTaskDefinitionCommand, 
  DescribeServicesCommand, 
  RunTaskCommand, 
  waitUntilTasksStopped, 
  waitUntilServicesStable, 
  UpdateServiceCommand
} = require("@aws-sdk/client-ecs");
const { CloudWatchLogsClient, GetLogEventsCommand } = require("@aws-sdk/client-cloudwatch-logs");
const { CodeDeployClient, AddTagsToOnPremisesInstancesCommand } = require("@aws-sdk/client-codedeploy");
const yaml = require('yaml');
const fs = require('fs');
const crypto = require('crypto');

// Attributes that are returned by DescribeTaskDefinition, but are not valid RegisterTaskDefinition inputs
const IGNORED_TASK_DEFINITION_ATTRIBUTES = [
  'compatibilities',
  'taskDefinitionArn',
  'requiresAttributes',
  'revision',
  'status',
  'registeredAt',
  'deregisteredAt',
  'registeredBy'
];

// Deploy to a service that uses the 'ECS' deployment controller
async function updateEcsService(ecs, clusterName, service, taskDefArn, waitForService, waitForMinutes, forceNewDeployment) {
  core.debug('Updating the service');
  await ecs.send(new UpdateServiceCommand({
    cluster: clusterName,
    service: service,
    taskDefinition: taskDefArn,
    forceNewDeployment: forceNewDeployment
  }));

  const consoleHostname = 'console.aws.amazon.com';

  core.info(`Deployment started. Watch this deployment's progress in the Amazon ECS console: https://${consoleHostname}/ecs/home?region=${process.env.AWS_REGION}#/clusters/${clusterName}/services/${service}/events`);

  // Wait for service stability
  if (waitForService && waitForService.toLowerCase() === 'true') {
    core.info(`Waiting for the service ${service} to become stable. Will wait for ${waitForMinutes} minutes`);
    await waitUntilServicesStable({client: ecs, maxDelay: 10, maxWaitTime: 600}, {
      services: [service],
      cluster: clusterName,
    });
  } else {
    core.debug('Not waiting for the service to become stable');
  }
}

// Find value in a CodeDeploy AppSpec file with a case-insensitive key
function findAppSpecValue(obj, keyName) {
  return obj[findAppSpecKey(obj, keyName)];
}

function findAppSpecKey(obj, keyName) {
  if (!obj) {
    throw new Error(`AppSpec file must include property '${keyName}'`);
  }

  const keyToMatch = keyName.toLowerCase();

  for (var key in obj) {
    if (key.toLowerCase() == keyToMatch) {
      return key;
    }
  }

  throw new Error(`AppSpec file must include property '${keyName}'`);
}

function isEmptyValue(value) {
  if (value === null || value === undefined || value === '') {
    return true;
  }

  if (Array.isArray(value)) {
    for (var element of value) {
      if (!isEmptyValue(element)) {
        // the array has at least one non-empty element
        return false;
      }
    }
    // the array has no non-empty elements
    return true;
  }

  if (typeof value === 'object') {
    for (var childValue of Object.values(value)) {
      if (!isEmptyValue(childValue)) {
        // the object has at least one non-empty property
        return false;
      }
    }
    // the object has no non-empty property
    return true;
  }

  return false;
}

function emptyValueReplacer(_, value) {
  if (isEmptyValue(value)) {
    return undefined;
  }

  if (Array.isArray(value)) {
    return value.filter(e => !isEmptyValue(e));
  }

  return value;
}

function cleanNullKeys(obj) {
  return JSON.parse(JSON.stringify(obj, emptyValueReplacer));
}

function removeIgnoredAttributes(taskDef) {
  for (var attribute of IGNORED_TASK_DEFINITION_ATTRIBUTES) {
    if (taskDef[attribute]) {
      core.warning(`Ignoring property '${attribute}' in the task definition file. ` +
        'This property is returned by the Amazon ECS DescribeTaskDefinition API and may be shown in the ECS console, ' +
        'but it is not a valid field when registering a new task definition. ' +
        'This field can be safely removed from your task definition file.');
      delete taskDef[attribute];
    }
  }

  return taskDef;
}

function maintainValidObjects(taskDef) {
  if (validateProxyConfigurations(taskDef)) {
    taskDef.proxyConfiguration.properties.forEach((property, index, arr) => {
      if (!('value' in property)) {
        arr[index].value = '';
      }
      if (!('name' in property)) {
        arr[index].name = '';
      }
    });
  }

  if (taskDef && taskDef.containerDefinitions) {
    taskDef.containerDefinitions.forEach((container) => {
      if (container.environment) {
        container.environment.forEach((property, index, arr) => {
          if (!('value' in property)) {
            arr[index].value = '';
          }
        });
      }
    });
  }
  return taskDef;
}

function validateProxyConfigurations(taskDef) {
  return 'proxyConfiguration' in taskDef && taskDef.proxyConfiguration.type && taskDef.proxyConfiguration.type == 'APPMESH' && taskDef.proxyConfiguration.properties && taskDef.proxyConfiguration.properties.length > 0;
}

// Deploy to a service that uses the 'CODE_DEPLOY' deployment controller
async function createCodeDeployDeployment(codedeploy, clusterName, service, taskDefArn, waitForService, waitForMinutes) {
  // core.debug('Updating AppSpec file with new task definition ARN');

  // let codeDeployAppSpecFile = core.getInput('codedeploy-appspec', { required: false });
  // codeDeployAppSpecFile = codeDeployAppSpecFile ? codeDeployAppSpecFile : 'appspec.yaml';

  // let codeDeployApp = core.getInput('codedeploy-application', { required: false });
  // codeDeployApp = codeDeployApp ? codeDeployApp : `AppECS-${clusterName}-${service}`;

  // let codeDeployGroup = core.getInput('codedeploy-deployment-group', { required: false });
  // codeDeployGroup = codeDeployGroup ? codeDeployGroup : `DgpECS-${clusterName}-${service}`;

  // let codeDeployDescription = core.getInput('codedeploy-deployment-description', { required: false });

  // let deploymentGroupDetails = await codedeploy.getDeploymentGroup({
  //   applicationName: codeDeployApp,
  //   deploymentGroupName: codeDeployGroup
  // }).promise();
  // deploymentGroupDetails = deploymentGroupDetails.deploymentGroupInfo;

  // // Insert the task def ARN into the appspec file
  // const appSpecPath = path.isAbsolute(codeDeployAppSpecFile) ?
  //   codeDeployAppSpecFile :
  //   path.join(process.env.GITHUB_WORKSPACE, codeDeployAppSpecFile);
  // const fileContents = fs.readFileSync(appSpecPath, 'utf8');
  // const appSpecContents = yaml.parse(fileContents);

  // for (var resource of findAppSpecValue(appSpecContents, 'resources')) {
  //   for (var name in resource) {
  //     const resourceContents = resource[name];
  //     const properties = findAppSpecValue(resourceContents, 'properties');
  //     const taskDefKey = findAppSpecKey(properties, 'taskDefinition');
  //     properties[taskDefKey] = taskDefArn;
  //   }
  // }

  // const appSpecString = JSON.stringify(appSpecContents);
  // const appSpecHash = crypto.createHash('sha256').update(appSpecString).digest('hex');

  // // Start the deployment with the updated appspec contents
  // core.debug('Starting CodeDeploy deployment');
  // let deploymentParams = {
  //   applicationName: codeDeployApp,
  //   deploymentGroupName: codeDeployGroup,
  //   revision: {
  //     revisionType: 'AppSpecContent',
  //     appSpecContent: {
  //       content: appSpecString,
  //       sha256: appSpecHash
  //     }
  //   }
  // };
  // // If it hasn't been set then we don't even want to pass it to the api call to maintain previous behaviour.
  // if (codeDeployDescription) {
  //   deploymentParams.description = codeDeployDescription
  // }
  // const createDeployResponse = await codedeploy.createDeployment(deploymentParams).promise();
  // core.setOutput('codedeploy-deployment-id', createDeployResponse.deploymentId);
  // core.info(`Deployment started. Watch this deployment's progress in the AWS CodeDeploy console: https://console.aws.amazon.com/codesuite/codedeploy/deployments/${createDeployResponse.deploymentId}?region=${aws.config.region}`);

  // // Wait for deployment to complete
  // if (waitForService && waitForService.toLowerCase() === 'true') {
  //   // Determine wait time
  //   const deployReadyWaitMin = deploymentGroupDetails.blueGreenDeploymentConfiguration.deploymentReadyOption.waitTimeInMinutes;
  //   const terminationWaitMin = deploymentGroupDetails.blueGreenDeploymentConfiguration.terminateBlueInstancesOnDeploymentSuccess.terminationWaitTimeInMinutes;
  //   let totalWaitMin = deployReadyWaitMin + terminationWaitMin + waitForMinutes;
  //   if (totalWaitMin > MAX_WAIT_MINUTES) {
  //     totalWaitMin = MAX_WAIT_MINUTES;
  //   }
  //   const maxAttempts = (totalWaitMin * 60) / WAIT_DEFAULT_DELAY_SEC;

  //   core.debug(`Waiting for the deployment to complete. Will wait for ${totalWaitMin} minutes`);
  //   await codedeploy.waitFor('deploymentSuccessful', {
  //     deploymentId: createDeployResponse.deploymentId,
  //     $waiter: {
  //       delay: WAIT_DEFAULT_DELAY_SEC,
  //       maxAttempts: maxAttempts
  //     }
  //   }).promise();
  // } else {
  //   core.debug('Not waiting for the deployment to complete');
  // }
}

async function run() {
  try {
    const ecs = new ECSClient({
      customUserAgent: 'amazon-ecs-deploy-task-definition-for-github-actions'
    });
    const codedeploy = new CodeDeployClient({
      customUserAgent: 'amazon-ecs-deploy-task-definition-for-github-actions'
    });
    const cloudwatch = new CloudWatchLogsClient({
      customUserAgent: 'amazon-ecs-deploy-task-definition-for-github-actions'
    });

    // Get inputs
    const taskDefinitionFile = core.getInput('task-definition', { required: true });
    const service = core.getInput('service', { required: false });
    const cluster = core.getInput('cluster', { required: false });
    const waitForService = core.getInput('wait-for-service-stability', { required: false });
    const preDeployCommand = core.getInput('pre-deploy-command', { required: false });
    let waitForMinutes = parseInt(core.getInput('wait-for-minutes', { required: false })) || 30;

    const forceNewDeployInput = core.getInput('force-new-deployment', { required: false }) || 'false';
    const forceNewDeployment = forceNewDeployInput.toLowerCase() === 'true';

    // Register the task definition
    core.info('Registering the task definition');
    const taskDefPath = path.isAbsolute(taskDefinitionFile) ?
      taskDefinitionFile :
      path.join(process.env.GITHUB_WORKSPACE, taskDefinitionFile);
    const fileContents = fs.readFileSync(taskDefPath, 'utf8');
    const taskDefContents = maintainValidObjects(removeIgnoredAttributes(cleanNullKeys(yaml.parse(fileContents))));
    let registerResponse;
    try {
      registerResponse = await ecs.send(new RegisterTaskDefinitionCommand(taskDefContents))
    } catch (error) {
      core.setFailed("Failed to register task definition in ECS: " + error.message);
      core.debug("Task definition contents:");
      core.debug(JSON.stringify(taskDefContents, undefined, 4));
      throw (error);
    }
    const taskDefArn = registerResponse.taskDefinition.taskDefinitionArn;
    core.info(`Task definition registered`);
    core.setOutput('task-definition-arn', taskDefArn);


    // Update the service with the new task definition
    if (service) {
      const clusterName = cluster ? cluster : 'default';

      // Determine the deployment controller

      const describeResponse = await ecs.send(new DescribeServicesCommand({
        services: [service],
        cluster: clusterName
      }));

      if (describeResponse.failures && describeResponse.failures.length > 0) {
        const failure = describeResponse.failures[0];
        throw new Error(`${failure.arn} is ${failure.reason}`);
      }

      const serviceResponse = describeResponse.services[0];
      if (serviceResponse.status != 'ACTIVE') {
        throw new Error(`Service is ${serviceResponse.status}`);
      }


      if (preDeployCommand) {
        core.info(`Running pre-deploy command: ${preDeployCommand}`);
        const networkConfig = {
          awsvpcConfiguration: {
            subnets: registerResponse.taskDefinition.networkMode === 'awsvpc' ? describeResponse.services[0].networkConfiguration.awsvpcConfiguration.subnets : [],
            securityGroups: registerResponse.taskDefinition.networkMode === 'awsvpc' ? describeResponse.services[0].networkConfiguration.awsvpcConfiguration.securityGroups : [],
            assignPublicIp: registerResponse.taskDefinition.networkMode === 'awsvpc' ? describeResponse.services[0].networkConfiguration.awsvpcConfiguration.assignPublicIp : 'DISABLED'
          }
        };
        const runTaskResponse = await ecs.send(new RunTaskCommand({
          taskDefinition: taskDefArn,
          cluster: cluster,
          launchType: serviceResponse.launchType,
          overrides: {
            taskRoleArn: registerResponse.taskDefinition.taskRoleArn,
            containerOverrides: [
              {
                name: registerResponse.taskDefinition.containerDefinitions[0].name,
                command: ["/bin/bash", "-c", preDeployCommand]
              }
            ]
          },
          networkConfiguration: networkConfig,
        }));
        if (runTaskResponse.failures && runTaskResponse.failures.length > 0) {
          const failure = runTaskResponse.failures[0];
          throw new Error(`Failure: ${failure.arn} is ${failure.reason}`);
        }
        core.info(`Waiting for pre-deploy task ${runTaskResponse.tasks[0].taskArn}...`)
        await waitUntilTasksStopped({client: ecs, maxDelay: 10, maxWaitTime: 300},{
          tasks: [runTaskResponse.tasks[0].taskArn],
          cluster: cluster
        });
        // Get log output from the task
        const task = runTaskResponse.tasks[0];
        const container = task.containers[0];
        if (container.exitCode && container.exitCode !== 0) {
          throw new Error(`Pre-deploy task exited with code ${container.exitCode}`);
        }
        // get log messages
        const logParams = {
          logGroupName: registerResponse.taskDefinition.containerDefinitions[0].logConfiguration.options['awslogs-group'],
          logStreamName: registerResponse.taskDefinition.containerDefinitions[0].logConfiguration.options['awslogs-stream-prefix'] + '/' + container.name + '/' + task.taskArn.split('/').pop(),
          startFromHead: true
        }
        core.info(`Getting log events from CloudWatch...`+JSON.stringify(logParams, undefined, 4))
        core.info(`task...`+JSON.stringify(task, undefined, 4))
        const logEvents = await cloudwatch.send(new GetLogEventsCommand(logParams));
        core.info(`Pre-deploy task output: `);
        logEvents.events.forEach(event => {
          core.info(event.message);
        });
      } else {
        core.info(`No pre-deploy command specified`);
      }

      if (!serviceResponse.deploymentController || !serviceResponse.deploymentController.type || serviceResponse.deploymentController.type === 'ECS') {
        // Service uses the 'ECS' deployment controller, so we can call UpdateService
        await updateEcsService(ecs, clusterName, service, taskDefArn, waitForService, waitForMinutes, forceNewDeployment);
      } else if (serviceResponse.deploymentController.type === 'CODE_DEPLOY') {
        // Service uses CodeDeploy, so we should start a CodeDeploy deployment
        await createCodeDeployDeployment(codedeploy, clusterName, service, taskDefArn, waitForService, waitForMinutes);
      } else {
        throw new Error(`Unsupported deployment controller: ${serviceResponse.deploymentController.type}`);
      }
    } else {
      core.debug('Service was not specified, no service updated');
    }
  }
  catch (error) {
    core.setFailed(error.message);
    core.debug(error.stack);
  }
}

module.exports = run;

/* istanbul ignore next */
if (require.main === module) {
  run();
}
