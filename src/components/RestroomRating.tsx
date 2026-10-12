/**
 * Score and star rating in the details panel.
 *
 * The score comes from POST /api/restrooms/scores (the server answers only for
 * restrooms the caller can see). Signed-in users get a 1 to 5 star control
 * showing their own rating, read live from `restroom_ratings` (each user can
 * read only their own rows); signed-out users get "Sign in to rate".
 *
 * Rating goes through the rateRestroom action. When a non-member's rating
 * makes the restroom premium, the action says only `visibleToCaller: false`,
 * and `onMembersOnly` closes the panel.
 */

import { useEffect, useState } from 'react'
import { useQuery } from 'deepspace'
import { Loader2, Star } from 'lucide-react'
import { cn } from '@/lib/utils'
import { fetchScores, rateRestroom, type ScoreAnswer } from '../lib/ratings-api'
import type { RestroomRating as RatingRow } from '../schemas/ratings-schema'

export function RestroomRating({
  restroomId,
  signedIn,
  onSignIn,
  onMembersOnly,
}: {
  restroomId: string
  signedIn: boolean
  onSignIn: () => void
  onMembersOnly: () => void
}) {
  const [score, setScore] = useState<{ id: string; value: ScoreAnswer | null } | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    fetchScores([restroomId], controller.signal)
      .then((scores) => setScore({ id: restroomId, value: scores[restroomId] ?? null }))
      .catch(() => {
        if (!controller.signal.aborted) setScore({ id: restroomId, value: null })
      })
    return () => controller.abort()
  }, [restroomId])
  const shown = score?.id === restroomId ? score.value : undefined

  return (
    <div data-testid="restroom-rating" className="mt-3 border-t border-border pt-3">
      <p data-testid="restroom-score" className="flex items-center gap-1.5 text-sm">
        <Star className="h-4 w-4 fill-amber-400 text-amber-500" aria-hidden />
        {shown === undefined ? (
          <span className="text-muted-foreground">Loading rating…</span>
        ) : shown === null ? (
          <span className="text-muted-foreground">No rating available</span>
        ) : (
          <>
            <strong>{shown.score.toFixed(1)}</strong>
            <span className="text-muted-foreground">
              · {shown.sample ? 'sample rating' : `${shown.ratingCount} ${shown.ratingCount === 1 ? 'rating' : 'ratings'}`}
            </span>
          </>
        )}
      </p>
      {signedIn ? (
        <MyStars
          restroomId={restroomId}
          onRated={(answer) => {
            if (!answer.visibleToCaller) onMembersOnly()
            else setScore({ id: restroomId, value: { score: answer.score, sample: answer.sample, ratingCount: answer.ratingCount } })
          }}
        />
      ) : (
        <button
          type="button"
          onClick={onSignIn}
          className="mt-2 text-sm font-medium text-foreground underline underline-offset-2"
        >
          Sign in to rate
        </button>
      )}
    </div>
  )
}

function MyStars({
  restroomId,
  onRated,
}: {
  restroomId: string
  onRated: (answer: Awaited<ReturnType<typeof rateRestroom>>) => void
}) {
  const { records } = useQuery<RatingRow>('restroom_ratings', { where: { restroomId } })
  const mine = records[0]?.data.stars ?? null
  const [saving, setSaving] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const current = saving ?? mine

  const rate = async (stars: number) => {
    setSaving(stars)
    setError(null)
    try {
      onRated(await rateRestroom(restroomId, stars))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Your rating could not be saved.')
    } finally {
      setSaving(null)
    }
  }

  return (
    <div className="mt-2">
      <div className="flex items-center gap-1" role="group" aria-label="Your rating">
        <span className="mr-1 text-xs text-muted-foreground">{mine ? 'Your rating' : 'Rate it'}</span>
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            disabled={saving !== null}
            onClick={() => void rate(n)}
            aria-label={`${n} ${n === 1 ? 'star' : 'stars'}`}
            aria-pressed={mine === n}
            className="rounded p-0.5 hover:bg-muted disabled:cursor-wait"
          >
            <Star
              className={cn('h-5 w-5', current !== null && n <= current ? 'fill-amber-400 text-amber-500' : 'text-muted-foreground')}
            />
          </button>
        ))}
        {saving !== null && <Loader2 className="ml-1 h-4 w-4 animate-spin text-muted-foreground" aria-label="Saving" />}
      </div>
      {error && (
        <p role="alert" className="mt-1 text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
