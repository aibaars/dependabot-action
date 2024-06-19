import * as core from '@actions/core'
import * as github from '@actions/github'
import * as httpClient from '@actions/http-client'
import {Context} from '@actions/github/lib/context'
import {ApiClient, Credential} from './api-client'
import {getJobParameters} from './inputs'
import {ImageService} from './image-service'
import {PROXY_IMAGE_NAME} from './docker-tags'
import {ProxyBuilder} from './proxy'
import Docker from 'dockerode'
import {pki, pkcs12, asn1} from 'node-forge'
import {writeFileSync, mkdirSync} from 'fs'
import {resolve, join} from 'path'
import {homedir} from 'os'

export enum DependabotErrorType {
  Unknown = 'actions_workflow_unknown',
  Image = 'actions_workflow_image',
  UpdateRun = 'actions_workflow_updater'
}

let jobId: number

type DependabotJobParameters = {
  jobToken: string
  dependabotApiUrl: string
  cachedMode: boolean
  credentials: Credential[]
  apiClient?: ApiClient
}

async function getDependabotJobParameters(
  context: Context
): Promise<DependabotJobParameters | null> {
  // Retrieve JobParameters from the Actions environment
  const params = getJobParameters(context)

  // The parameters will be null if the Action environment
  // is not a valid Dependabot-triggered dynamic event.
  if (params === null) {
    botSay('finished: nothing to do')
    return null // TODO: This should be setNeutral in future
  }

  // Use environment variables if set and not empty, otherwise use parameters.
  // The param values of job token and credentials token are kept to support backwards compatibility.
  const jobToken = process.env.GITHUB_DEPENDABOT_JOB_TOKEN || params.jobToken
  const credentialsToken =
    process.env.GITHUB_DEPENDABOT_CRED_TOKEN || params.credentialsToken

  // Validate jobToken and credentialsToken
  if (!jobToken) {
    const errorMessage = 'Github Dependabot job token is not set'
    botSay(`finished: ${errorMessage}`)
    core.setFailed(errorMessage)
    return null
  }
  if (!credentialsToken) {
    const errorMessage = 'Github Dependabot credentials token is not set'
    botSay(`finished: ${errorMessage}`)
    core.setFailed(errorMessage)
    return null
  }

  jobId = params.jobId
  core.setSecret(jobToken)
  core.setSecret(credentialsToken)

  const client = new httpClient.HttpClient('github/dependabot-action')
  const apiClient = new ApiClient(client, params, jobToken, credentialsToken)

  try {
    core.info('Fetching job details')
    // If we fail to succeed in fetching the job details, we cannot be sure the job has entered a 'processing' state,
    // so we do not try attempt to report back an exception if this fails and instead rely on the workflow run
    // webhook as it anticipates scenarios where jobs have failed while 'enqueued'.
    const details = await apiClient.getJobDetails()
    const credentials = await apiClient.getCredentials()

    const cachedMode =
      details.experiments?.hasOwnProperty('proxy-cached') === true
    return {
      jobToken,
      dependabotApiUrl: params.dependabotApiUrl,
      cachedMode,
      credentials,
      apiClient
    }
  } catch (error: unknown) {
    if (error instanceof Error) {
      setFailed('Dependabot encountered an unexpected problem', error)
      botSay(`finished: unexpected error: ${error}`)
      return null
    } else {
      throw error
    }
  }
}
export async function run(context: Context): Promise<void> {
  // try {
  botSay(JSON.stringify(context.payload.inputs))
  botSay('starting update')
  core.startGroup('Pstart')
  core.endGroup()

  const jobParameters = await getDependabotJobParameters(context)
  const {jobToken, dependabotApiUrl, cachedMode, credentials, apiClient} =
    jobParameters || getCredentialsFromEnv()

  core.startGroup('Pulling updater images')
  core.endGroup()

  try {
    await ImageService.pull(PROXY_IMAGE_NAME)
  } catch (error: unknown) {
    if (error instanceof Error) {
      await failJob(
        apiClient,
        `Error fetching updater images${error.message}`,
        error,
        DependabotErrorType.Image
      )
      return
    }
  }
  core.endGroup()

  const docker = new Docker()
  botSay('initialize proxy builder')
  const proxyBuilder = new ProxyBuilder(docker, PROXY_IMAGE_NAME, cachedMode)
  botSay('building proxy')
  const proxy = await proxyBuilder.run(
    jobId,
    jobToken,
    dependabotApiUrl,
    credentials
  )
  botSay('start proxy')
  await proxy.container.start()
  core.saveState('PROXY_CONTAINER_ID', proxy.container.id)
  const proxyUrl = new URL(await proxy.url())
  const password = 'changeit'
  const p12 = pkcs12.toPkcs12Asn1(
    // generate dummy key
    pki.rsa.generateKeyPair(2048).privateKey,
    pki.certificateFromPem(proxy.cert),
    password,
    {
      algorithm: '3des',
      friendlyName: 'mykey',
      generateLocalKeyId: false,
      useMac: true,
      count: 10000,
      saltSize: 20
    }
  )

  const trustStore = resolve('keystore.p12')
  const pemFile = resolve('cert.pem')
  writeFileSync(trustStore, asn1.toDer(p12).getBytes(), {encoding: 'binary'})
  writeFileSync(pemFile, proxy.cert)
  const JAVA_SSL_OPTS = `-Djavax.net.ssl.trustStore=${trustStore} -Djavax.net.ssl.trustStoreType=PKCS12 -Djavax.net.ssl.trustStorePassword=${password}`
  const JAVA_PROXY_OPTS = `-Dhttp.proxyHost=${proxyUrl.hostname} -Dhttp.proxyPort=${proxyUrl.port} -Dhttps.proxyHost=${proxyUrl.hostname} -Dhttps.proxyPort=${proxyUrl.port}`

  const settings = `<settings xmlns="http://maven.apache.org/SETTINGS/1.2.0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" \
    xsi:schemaLocation="http://maven.apache.org/SETTINGS/1.2.0 http://maven.apache.org/xsd/settings-1.2.0.xsd">\
    <proxies>\
      <proxy><protocol>http</protocol><host>${proxyUrl.hostname}</host><port>${proxyUrl.port}</port></proxy>\
      <proxy><protocol>https</protocol><host>${proxyUrl.hostname}</host><port>${proxyUrl.port}</port></proxy>\
    </proxies>\
  </settings>`
  const m2_dir = join(homedir(), '.m2')
  mkdirSync(m2_dir, {recursive: true})
  writeFileSync(join(m2_dir, 'settings.xml'), settings)

  core.exportVariable(
    'MAVEN_OPTS',
    `${JAVA_SSL_OPTS} -DproxySet=true ${JAVA_PROXY_OPTS} ${process.env.MAVEN_OPTS || ''}`
  )
  core.exportVariable(
    'GRADLE_OPTS',
    `${JAVA_SSL_OPTS} ${JAVA_PROXY_OPTS} ${process.env.GRADLE_OPTS || ''}`
  )
  core.exportVariable(
    'SEMMLE_JAVA_EXTRACTOR_JVM_ARGS',
    `${JAVA_SSL_OPTS} ${JAVA_PROXY_OPTS} ${process.env.SEMMLE_JAVA_EXTRACTOR_JVM_ARGS || ''}`
  )
  core.exportVariable('CODEQL_JAVA_EXTRACTOR_TRUST_STORE_PATH', `${trustStore}`)
  core.exportVariable('PROXY_NETWORK_NAME', `${proxy.networkName}`)
  core.exportVariable('PROXY_HOST', `${proxyUrl.hostname}`)
  core.exportVariable('PROXY_PORT', `${proxyUrl.port}`)
  core.exportVariable('PROXY_CA_CERT', `${pemFile}`)
}

async function failJob(
  apiClient: ApiClient | undefined,
  message: string,
  error: Error,
  errorType = DependabotErrorType.Unknown
): Promise<void> {
  if (apiClient) {
    await apiClient.reportJobError({
      'error-type': errorType,
      'error-details': {
        'action-error': error.message
      }
    })
    await apiClient.markJobAsProcessed()
  }
  setFailed(message, error)
  botSay('finished: error reported to Dependabot')
}

function botSay(message: string): void {
  core.info(`🤖 ~ ${message} ~`)
}

function setFailed(message: string, error: Error | null): void {
  if (jobId) {
    message = [message, error, dependabotJobHelp()].filter(Boolean).join('\n\n')
  }

  core.setFailed(message)
}

function dependabotJobHelp(): string | null {
  if (jobId) {
    return `For more information see: ${dependabotJobUrl(
      jobId
    )} (write access to the repository is required to view the log)`
  } else {
    return null
  }
}

function dependabotJobUrl(id: number): string {
  const url_parts = [
    process.env.GITHUB_SERVER_URL,
    process.env.GITHUB_REPOSITORY,
    'network/updates',
    id
  ]

  return url_parts.filter(Boolean).join('/')
}

function getCredentialsFromEnv(): DependabotJobParameters {
  const credentialsText = process.env.DEPENDABOT_CREDENTIALS || '[]'
  const credentials: Credential[] = JSON.parse(credentialsText)
  return {
    jobToken: '',
    dependabotApiUrl: '',
    cachedMode: true,
    credentials,
    apiClient: undefined
  }
}

if (require.main === module) {
  run(github.context)
}
