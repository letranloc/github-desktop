import { escapeRegExp } from 'lodash'
import { GitHubRepository } from '../../models/github-repository'
import { getHTMLURL } from '../api'
import { INodeFilter } from './node-filter'

/**
 * The Commit mention Link filter matches the target and text of an anchor element that
 * is an commit mention link and changes the text to a uniform
 * reference.
 *
 * Types of commit mention links:
 * - Plain Single Commit: https://github.com/desktop/desktop/commit/6fd794543af171c35cc9c325f570f9553128ffc9
 * - Compare a range of Commits: https://github.com/desktop/desktop/compare/6fd794543...6fd794543
 * - Pull Request Commit: https://github.com/desktop/desktop/pull/14239/commits/6fd794543af171c35cc9c325f570f9553128ffc9
 *
 * Example:
 * <a href="https://github.com/desktop/desktop/commit/6fd794543af171c35cc9c325f570f9553128ffc9">https://github.com/desktop/desktop/commit/6fd794543af171c35cc9c325f570f9553128ffc9</a>
 *
 * Becomes
 * <a href="https://github.com/desktop/desktop/commit/6fd794543af171c35cc9c325f570f9553128ffc9">6fd7945</a>
 *
 * or this, if not owned by current repository,
 * <a href="https://github.com/desktop/desktop/commit/6fd794543af171c35cc9c325f570f9553128ffc9">desktop/desktop@6fd7945</a>
 *
 *
 * The intention behind this node filter is for use after the markdown parser
 * that has taken raw urls and auto tagged them them as anchor elements.
 */
export class CommitMentionLinkFilter implements INodeFilter {
  /** A regexp that searches for the owner/name pattern in issue href */
  private readonly nameWithOwner =
    /(?<owner>-?[a-z0-9][a-z0-9\-\_]*)\/(?<name>(?:\w|\.|\-)+)/

  /**
   * A regexp that searches for a url path pattern for a commit
   *
   * Example: /desktop/desktop/commit/6fd7945
   */
  private readonly commitPath = new RegExp(
    /^\//.source +
      this.nameWithOwner.source +
      /\/commit\/(?<pathFragment>.+)$/.source
  )

  /**
   * A regexp that searches for a url path pattern for a compare
   *
   * Example: /desktop/desktop/commit/6fd7945...6fd7945
   */
  private readonly comparePath = new RegExp(
    /^\//.source + this.nameWithOwner.source + /\/compare\/(?<range>.+)$/.source
  )

  /**
   * A regexp that searches for a url path pattern for a compare
   *
   * Example: /desktop/desktop/commit/6fd7945...6fd7945
   */
  private readonly pullCommitPath = new RegExp(
    /^\//.source +
      this.nameWithOwner.source +
      /\/pull\/(\d+)\/commits\/(?<sha>([^.]|\.{2,})+)$/.source
  )

  private readonly sha = /^[0-9a-f]{7,40}$/

  /** A regexp that matches a full issue, pull request, or discussion url
   * including the anchor */
  private get commitMentionUrl(): RegExp {
    const gitHubURL = getHTMLURL(this.repository.endpoint)
    return new RegExp(
      escapeRegExp(gitHubURL) +
        '/' +
        this.nameWithOwner.source +
        '/' +
        /(commit|pull|compare)/.source +
        '/' +
        /(\d+\/commits\/)?/.source +
        /([0-9a-f]{7,40})/.source +
        /\b/.source
    )
  }

  /** The parent github repository of which the content the filter is being
   * applied to belongs  */
  private readonly repository: GitHubRepository

  public constructor(repository: GitHubRepository) {
    this.repository = repository
  }

  /**
   * Commit mention link filter iterates on all anchor elements that are not
   * inside a pre, code, or anchor tag and resemble a commit mention link and
   * their href matches their inner text.
   *
   * Looking for something like:
   * <a href="https://github.com/desktop/desktop/commit/6fd7945">https://github.com/desktop/desktop/commit/6fd7945</a>
   * Where the href could be like:
   *  - Plain Single Commit: https://github.com/desktop/desktop/commit/6fd7945
   *  - Compare a range of Commits: https://github.com/desktop/desktop/compare/6fd7945...6fd7945
   *  - Pull Request Commit: https://github.com/desktop/desktop/pull/14239/commits/6fd7945
   */
  public createFilterTreeWalker(doc: Document): TreeWalker {
    return doc.createTreeWalker(doc, NodeFilter.SHOW_ELEMENT, {
      acceptNode: (el: Element) => {
        return (el.parentNode !== null &&
          ['CODE', 'PRE', 'A'].includes(el.parentNode.nodeName)) ||
          !(el instanceof HTMLAnchorElement) ||
          el.href !== el.innerText ||
          !this.commitMentionUrl.test(el.href)
          ? NodeFilter.FILTER_SKIP
          : NodeFilter.FILTER_ACCEPT
      },
    })
  }

  /**
   * Takes an anchor element that's href and inner text looks like a github
   * references and prepares an anchor element with a consistent issue reference
   * as the inner text to replace it with.
   *
   * Example:
   * Anchor tag of = <a href="https://github.com/owner/repo/issues/1234">https://github.com/owner/repo/issues/1234</a>
   * Output = [<a href="https://github.com/owner/repo/issues/1234">#1234</a>]
   */
  public async filter(node: Node): Promise<ReadonlyArray<Node> | null> {
    const { textContent: text } = node
    if (!(node instanceof HTMLAnchorElement) || text === null) {
      return null
    }

    const url = new URL(text)
    const path = url.pathname

    const commitPathMatch = path.match(this.commitPath)
    if (commitPathMatch !== null && commitPathMatch.groups !== undefined) {
      const { owner, name, pathFragment } = commitPathMatch.groups
      const [possibleSha, filePath] = pathFragment.split('/', 2)
      if (possibleSha === undefined) {
        return null
      }
      const [sha, format] = possibleSha.split('.')

      if (
        sha === undefined ||
        this.isReservedCommitActionPath(filePath) ||
        format !== undefined
      ) {
        return null
      }

      const newNode = node.cloneNode(true)
      if (!(newNode instanceof HTMLAnchorElement)) {
        return null
      }
      const filePathAppended =
        filePath !== undefined ? '/' + filePath + url.search : filePath
      newNode.innerHTML = this.getCommitMentionRef(
        owner,
        name,
        this.trimCommitSha(sha),
        filePathAppended
      )
      return [newNode]
    }

    const comparePathMatch = path.match(this.comparePath)
    if (comparePathMatch !== null && comparePathMatch.groups !== undefined) {
      const { owner, name, range } = comparePathMatch.groups

      const newNode = node.cloneNode(true)
      if (!(newNode instanceof HTMLAnchorElement)) {
        return null
      }

      if (/\.(diff|path)$/.test(range)) {
        return null
      }

      const shas = range.split('...')
      if (shas.length > 2) {
        return null
      }

      const [secondSha, filePath] = shas[1].split('/', 2)
      const formattedRange = `${this.trimCommitSha(
        shas[0]
      )}...${this.trimCommitSha(secondSha)}`

      const filePathAppended =
        filePath !== undefined ? '/' + filePath + url.search : filePath

      newNode.innerHTML = this.getCommitMentionRef(
        owner,
        name,
        formattedRange,
        filePathAppended
      )
      return [newNode]
    }

    const pullCommitPathMatch = path.match(this.pullCommitPath)
    if (
      pullCommitPathMatch !== null &&
      pullCommitPathMatch.groups !== undefined
    ) {
      const { owner, name, sha } = pullCommitPathMatch.groups
      if (!this.sha.test(sha)) {
        return null
      }

      const newNode = node.cloneNode(true)
      if (!(newNode instanceof HTMLAnchorElement)) {
        return null
      }
      newNode.innerHTML = this.getCommitMentionRef(
        owner,
        name,
        this.trimCommitSha(sha)
      )

      return [newNode]
    }

    return null
  }

  /**
   * Commit action path's are formatted nor shortened.
   *
   * Commit links could be action paths
   * ${github.url}/owner/repo/commit/1234567/${actionPathPossibility}
   *
   * where actionPathPossibility could look like:
   * "_render_node/partialpath"
   * "checks"
   * "checks/123"
   * "checks/123/logs"
   * "checks_state_summary"
   * "hovercard"
   *  "rollup"
   * "show_partial"
   */
  private isReservedCommitActionPath(filePath: string) {
    const commitActions = [
      'checks_state_summary',
      'hovercard',
      'rollup',
      'show_partial',
    ]
    if (filePath === undefined) {
      return false
    }

    const commitActionsWithParams = ['_render_node', 'checks']
    return (
      commitActions.includes(filePath) ||
      commitActionsWithParams.includes(filePath.split('/')[0])
    )
  }

  /**
   * Creates commit sha references
   */
  private getCommitMentionRef(
    owner: string,
    name: string,
    shaRef: string,
    filePath?: string
  ) {
    const ownerRepo =
      owner !== this.repository.owner.login || name !== this.repository.name
        ? `${owner}/${name}@`
        : ''
    const trimmedSha = this.trimCommitSha(shaRef)
    return `${ownerRepo}<tt>${trimmedSha}</tt>${filePath ?? ''}`
  }

  /**
   * Method to trim the shas
   *
   * If sha >= 30, trimmed to first 7
   */
  private trimCommitSha(sha: string) {
    return sha.length >= 30 ? sha.slice(0, 7) : sha
  }
}