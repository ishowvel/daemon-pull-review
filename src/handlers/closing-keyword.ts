import { Context } from "../types";
import { CallbackResult } from "../types/proxy";
import { PullReviewer } from "./pull-reviewer";

/**
 * Handler for the `pull_request.edited` webhook event.
 * It checks whether the pull request body was edited and now includes a closing keyword.
 * If so, it runs the pull request precheck.
 *
 * @param context
 */
export async function handlePullRequestEditedEvent(context: Context<"pull_request.edited">): Promise<CallbackResult> {
  const { payload, logger } = context;

  const newBody = payload.pull_request.body;
  if (!newBody) {
    return { status: 200, reason: "Pull request body is empty, Aborting" };
  }
  if (!payload.changes.body?.from) {
    return { status: 200, reason: "Pull request body wasnt edited, Skipping" };
  }

  const oldBody: string = payload.changes.body.from;

  // Find matches in both the old and new bodies
  const oldMatch = extractIssueUrls(oldBody, context.payload.repository.full_name);
  const newMatch = extractIssueUrls(newBody, context.payload.repository.full_name);
  console.error(await getLinkedIssues(context));
  console.error(newMatch);
  if ((newMatch.size !== 0 && newMatch.size !== oldMatch.size) || [...newMatch].some((url) => !oldMatch.has(url))) {
    logger.info("Pull request body edit detected", {
      oldLinkedIssues: oldMatch,
      newLinkedIssues: newMatch,
    });
    const pullReviewer = new PullReviewer(context);
    return await pullReviewer.performPullPrecheck();
  }
  return { status: 200, reason: "No new closing keyword with an issue reference detected in the PR body edit" };
}

export function extractIssueUrls(pullBody: string, defaultRepo: string): Set<string> {
  const bodyWithoutComments = pullBody.replace(/<!--[\s\S]*?-->/g, "");

  const pattern =
    /(?:close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)\s+(?:(https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/(\d+))|([^/\s]+\/[^#\s]+)#(\d+)|#(\d+))/gi;
  const matches = bodyWithoutComments.matchAll(pattern);
  const issueUrls = new Set<string>();

  for (const match of matches) {
    const fullUrl = match[1];
    const repoPath = match[4];
    const issueNum1 = match[5];
    const issueNum2 = match[6];

    if (fullUrl) {
      issueUrls.add(fullUrl);
    } else if (repoPath) {
      issueUrls.add(`https://github.com/${repoPath}/issues/${issueNum1}`);
    } else {
      issueUrls.add(`https://github.com/${defaultRepo}/issues/${issueNum2}`);
    }
  }

  return issueUrls;
}

interface LinkedIssue {
  number: number;
  title: string;
  state: string;
  repository: {
    nameWithOwner: string;
  };
}

interface QueryResponse {
  repository: {
    pullRequest: {
      closingIssuesReferences: {
        nodes: LinkedIssue[];
      };
    };
  };
}

export async function getLinkedIssues(context: Context) {
  const query = `
    query($owner: String!, $repo: String!, $prNumber: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $prNumber) {
          closingIssuesReferences(first: 100) {
            nodes {
              number
              title
              state
              repository {
                nameWithOwner
              }
            }
          }
        }
      }
    }
  `;
  const prNumber = context.payload.pull_request.number;

  const response = await context.octokit.graphql<QueryResponse>(query, {
    owner: context.payload.repository.owner.login,
    repo: context.payload.repository.name,
    prNumber,
  });

  return response.repository.pullRequest.closingIssuesReferences.nodes;
}
