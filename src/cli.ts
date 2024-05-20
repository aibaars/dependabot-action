#!/usr/bin/env node

import {Command} from 'commander'
import {Context} from '@actions/github/lib/context'
import {run} from './main'
import * as cleanup from './cleanup'

const cli = new Command()

cli
  .version('0.0.1')
  .description('Run an update against the specified Dependabot API service')
  .option('-j, --job-id <id>', 'Job ID is required.')
  .option('-t, --job-token <token>', 'Job token required.')
  .option('-w, --working-directory <path>', 'Working directory required.')
  .option(
    '-c, --credentials-token <token>',
    'Job credentials token is required.'
  )
  .option(
    '-d, --dependabot-api-url <url>',
    'A URL for Dependabot API is required.'
  )
  .option(
    '-d, --dependabot-api-docker-url <url>',
    'A URL to be used to access the API from Dependabot containers.'
  )
  .parse(process.argv)

const options = cli.opts()
const ctx = new Context()
ctx.eventName = 'dynamic'
ctx.actor = 'dependabot[bot]'
ctx.payload = {
  inputs: options
}
run(ctx)
cleanup.run()
