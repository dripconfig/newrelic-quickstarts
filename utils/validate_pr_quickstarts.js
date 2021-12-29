'use strict';

const glob = require('glob');

const { fetchPaginatedGHResults } = require('./github-api-helpers');
const {
  findMainQuickstartConfigFiles,
  readQuickstartFile,
  removeRepoPathPrefix,
} = require('./helpers');
const {
  fetchNRGraphqlResults,
  translateMutationErrors,
} = require('./nr-graphql-helpers');

const GITHUB_API_URL = process.argv[2];
const GITHUB_REPO_BASE_URL =
  'https://github.com/newrelic/newrelic-quickstarts/tree/main';
const GITHUB_RAW_BASE_URL =
  'https://raw.githubusercontent.com/newrelic/newrelic-quickstarts/main';
const NR_API_URL = process.env.NR_API_URL;
const NR_API_TOKEN = process.env.NR_API_TOKEN;
const VALIDATE_QUICKSTART_MUTATION = `# gql
mutation (
  $dryRun: Boolean
  $id: ID!
  $quickstartMetadata: Nr1CatalogQuickstartMetadataInput!
) {
    nr1CatalogSubmitQuickstart(
      dryRun: $dryRun
      id: $id
      quickstartMetadata: $quickstartMetadata
    ) {
        quickstart {
          id
        }
      }
  }
`;

/**
 * Gets the quickstart portion of a given file path.
 * @param {String} filePath - Full file path of a file in a quickstart.
 * @param {String} targetChild - Node in file path that should be preceded by a quickstart directory.
 * @return {String} Node in file path of the quickstart.
 */
const getQuickstartNode = (filePath, targetChild) => {
  const splitFilePath = filePath.split('/');
  return splitFilePath[
    splitFilePath.findIndex((path) => path === targetChild) - 1
  ];
};

/**
 * Identifies where in a given file path to look for a quickstart directory.
 * @param {String} filePath - Full file path of a file in a quickstart.
 * @return {Function|undefined} Called function with arguments to determine the quickstart of a given file path.
 */
const getQuickstartFromFilename = (filePath) => {
  if (
    !filePath.includes('quickstarts/') &&
    !filePath.includes('mock_quickstarts/')
  ) {
    return;
  }

  if (filePath.includes('/alerts/')) {
    return getQuickstartNode(filePath, 'alerts');
  }

  if (filePath.includes('/dashboards/')) {
    return getQuickstartNode(filePath, 'dashboards');
  }

  if (filePath.includes('/images/')) {
    return getQuickstartNode(filePath, 'images');
  }

  const targetChildNode = filePath.split('/').pop();

  return getQuickstartNode(filePath, targetChildNode);
};

/**
 * Looks up corresponding quickstart config files for quickstarts known to have changes in a PR.
 * @param {Set} quickstartDirectories - Set of unique quickstart directories.
 * @return {Array} Collection of config file paths.
 */
const getQuickstartConfigPaths = (quickstartDirectories) => {
  const allQuickstartConfigPaths = findMainQuickstartConfigFiles();

  return [...quickstartDirectories].reduce((acc, quickstartDirectory) => {
    const match = allQuickstartConfigPaths.find((path) =>
      path.split('/').includes(quickstartDirectory)
    );
    if (match) {
      acc.push(match);
    }
    return acc;
  }, []);
};

/**
 * Builds input argument for submitQuickstart GraphQL mutation
 * @param {Object} quickstartConfig - An object containing the path and contents of a quickstart config file.
 * @return {Object} An object that represents a quickstart in the context of a GraphQL mutation
 */
const buildMutationVariables = (quickstartConfig) => {
  const {
    authors,
    categoryTerms,
    description,
    title,
    documentation,
    logo,
    keywords,
    summary,
    installPlans,
    id,
  } = quickstartConfig.contents[0] || {};
  const alertConfigPaths = getQuickstartAlertsConfigs(quickstartConfig.path);
  const dashboardConfigPaths = getQuickstartDashboardConfigs(
    quickstartConfig.path
  );

  return {
    dryRun: true,
    id: id,
    quickstartMetadata: {
      alertConditions: adaptQuickstartAlertsInput(alertConfigPaths),
      authors: authors && authors.map((author) => ({ name: author })),
      categoryTerms: categoryTerms || keywords,
      description: description && description.trim(),
      displayName: title && title.trim(),
      documentation: adaptQuickstartDocumentationInput(documentation),
      icon:
        logo &&
        `${GITHUB_RAW_BASE_URL}/${getQuickstartRelativePath(
          quickstartConfig.path
        )}/${logo}`,
      keywords: keywords,
      sourceUrl: `${GITHUB_REPO_BASE_URL}/${getQuickstartRelativePath(
        quickstartConfig.path
      )}`,
      summary: summary && summary.trim(),
      installPlanStepIds: installPlans,
      dashboards: adaptQuickstartDashboardInput(dashboardConfigPaths),
    },
  };
};

/**
 * Gets the relative path of a quickstart from the root config file path.
 * @param {String} configPath - The file path to the root config file of a quickstart
 * @return {String} Returns the relative path of a quickstart
 */
const getQuickstartRelativePath = (configPath) => {
  const splitConfigPath = configPath.split('/');
  splitConfigPath.pop();
  return removeRepoPathPrefix(splitConfigPath.join('/'));
};

/**
 * Gets the file path of a config file within the `alerts` directory of a quickstart.
 * @param {String} quickstartConfigPath - The file path to the root config file of a quickstart
 * @return {String} Returns the file path of the config file within the `alerts` directory of quickstart (String).
 */
const getQuickstartAlertsConfigs = (quickstartConfigPath) => {
  const splitConfigPath = quickstartConfigPath.split('/');
  splitConfigPath.pop();
  const globPattern = `${splitConfigPath.join('/')}/alerts/*.+(yml|yaml)`;

  return glob.sync(globPattern);
};

/**
 * Builds input arguments for the `alertConditions` field.
 * @param {Array} alertConfigPaths - File paths of config files within an `alerts` directory.
 * @param {Array} Returns an object that represents a quickstart's alerts in the context of a GraphQL mutation
 */
const adaptQuickstartAlertsInput = (alertConfigPaths) =>
  alertConfigPaths.length > 0
    ? alertConfigPaths.map((alertConfigPath) => {
        const parsedConfig = readQuickstartFile(alertConfigPath);
        const { details, name, type } = parsedConfig.contents[0];

        return {
          description: details && details.trim(),
          displayName: name && name.trim(),
          rawConfiguration: JSON.stringify(parsedConfig.contents[0]),
          type: type && type.trim(),
        };
      })
    : undefined;

/**
 * Creates the filepath of a config file within the `dashboards` directory of quickstart.
 * @param {String} quickstartConfigPath - Filepath of the root config file.
 * @returns {String} Returns the dashboard config file path.
 */
const getQuickstartDashboardConfigs = (quickstartConfigPath) => {
  const splitConfigPath = quickstartConfigPath.split('/');
  splitConfigPath.pop();
  const globPattern = `${splitConfigPath.join('/')}/dashboards/*.+(json)`;

  return glob.sync(globPattern);
};

/**
 * Builds input arguments for the `dashboards` field.
 * @param {Array} alertConfigPaths - The file paths of config files within a `dashboards` directory.
 * @param {Array} Returns an object that represents a quickstart's dashboards in the context of a GraphQL mutation
 */
const adaptQuickstartDashboardInput = (dashboardConfigPaths) =>
  dashboardConfigPaths.length > 0
    ? dashboardConfigPaths.map((dashboardConfigPath) => {
        const parsedConfig = readQuickstartFile(dashboardConfigPath);
        const { description, name } = parsedConfig.contents[0];
        const screenshotPaths =
          getQuickstartDashboardScreenshotPaths(dashboardConfigPath);
        return {
          description: description && description.trim(),
          displayName: name && name.trim(),
          rawConfiguration: JSON.stringify(parsedConfig.contents[0]),
          screenshots: screenshotPaths && screenshotPaths.map(getScreenshotUrl),
        };
      })
    : undefined;

/**
 * Creates the GitHub url of each screenshot within the main directory of a quickstart.
 * @param {String} path - The file path of a screenshot
 * @return{Object} Returns an object containing the GitHub url of a screenshot
 */
const getScreenshotUrl = (path) => {
  const screenshotFilename = path.split('/').pop();

  return {
    url: `${GITHUB_RAW_BASE_URL}/${getQuickstartRelativePath(
      path
    )}/${screenshotFilename}`,
  };
};

/**
 * Creates the file path of each screenshot within the dashboard directory of a quickstart.
 * @param {String} dashboardConfigPath - The file path of the config file within a quickstart's `dashboards` directory
 * @return {String} Returns file paths of any screenshot within the same `dashboards` directory
 */
const getQuickstartDashboardScreenshotPaths = (dashboardConfigPath) => {
  const splitConfigPath = dashboardConfigPath.split('/');
  splitConfigPath.pop();
  const globPattern = `${splitConfigPath.join('/')}/*.+(jpeg|jpg|png)`;

  return glob.sync(globPattern);
};

/**
 * Builds input arguments for the `documentation` field.
 * @param {Array} documentation - The documentation sections of a config.yml file.
 * @return {Array} Returns quickstart documentation in the context of a GraphQL mutation
 */
const adaptQuickstartDocumentationInput = (documentation) =>
  documentation &&
  documentation.map((doc) => {
    const { name, url, description } = doc;
    return {
      displayName: name,
      url,
      description,
    };
  });

/**
 * Creates a Set of unique quickstarts that were updated.
 * @param {Set} acc - A set of unique quickstarts being built by reducer function
 * @param {Object} curr - A result from the GitHub API
 * @return {Set} returns a Set of unique quickstarts that were updated.
 */
const buildUniqueQuickstartSet = (acc, { filename }) => {
  return getQuickstartFromFilename(filename)
    ? acc.add(getQuickstartFromFilename(filename))
    : acc;
};

/**
 *Creates graphql requests to be used in the SubmitQuickstartMetadata mutation.
 * @param {Array} files - A list of quickstarts changed in the PR
 * @return {Array} Returns objects containing the file path of a quickstart's root config file and the variables used in the SubmitQuickstart mutation.
 */
const getGraphqlRequests = (files) => {
  const uniqueQuickstarts = files.reduce(buildUniqueQuickstartSet, new Set());
  const quickstartConfigPaths = getQuickstartConfigPaths(uniqueQuickstarts);

  return quickstartConfigPaths.map((configPath) => ({
    filePath: removeRepoPathPrefix(configPath),
    variables: buildMutationVariables(readQuickstartFile(configPath)),
  }));
};

const main = async () => {
  const files = await fetchPaginatedGHResults(
    GITHUB_API_URL,
    process.env.GITHUB_TOKEN
  ).catch((error) => {
    throw new Error(`GitHub API returned: ${error.message}`);
  });

  const graphqlRequests = getGraphqlRequests(files);

  const graphqlResponses = await Promise.all(
    graphqlRequests.map(async ({ variables, filePath }) => {
      const { data, errors } = await fetchNRGraphqlResults(
        {
          queryString: VALIDATE_QUICKSTART_MUTATION,
          variables,
        },
        NR_API_URL,
        NR_API_TOKEN
      );

      return { data, errors, filePath };
    })
  );

  let hasFailed = false;

  graphqlResponses.forEach(({ errors, filePath }) => {
    if (errors.length > 0) {
      hasFailed = true;
      translateMutationErrors(errors, filePath);
    }
  });

  if (hasFailed) {
    process.exit(1);
  }

  process.exit(0);
};

/**
 * This allows us to check if the script was invoked directly from the command line, i.e 'node validate_quickstarts.js', or if it was imported.
 * This would be true if this was used in one of our GitHub workflows, but false when imported for use in a test.
 * See here: https://nodejs.org/docs/latest/api/modules.html#modules_accessing_the_main_module
 */
if (require.main === module) {
  main();
}

module.exports = {
  getQuickstartFromFilename,
  getQuickstartConfigPaths,
  buildMutationVariables,
  buildUniqueQuickstartSet,
  getGraphqlRequests,
};
