import { NextResponse } from "next/server";
import { getPool } from "@/utils/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const pool = getPool();
  try {
    const [overall, byTag, byDay, byFailedKey, recent] = await Promise.all([
      pool.query(`
        SELECT COUNT(*)::int                                                   AS total,
               SUM((review_metadata->>'verdict'='pass')::int)::int             AS pass_n,
               SUM((review_metadata->>'verdict'='partial')::int)::int          AS partial_n,
               SUM((review_metadata->>'verdict'='fail')::int)::int             AS fail_n,
               AVG((review_metadata->>'overall_score')::float)                 AS avg_overall,
               AVG((review_metadata->>'semantic_match_score')::float)          AS avg_sem,
               AVG((review_metadata->>'parameter_match_score')::float)         AS avg_param
        FROM sim_run
        WHERE review_metadata IS NOT NULL
      `),
      pool.query(`
        SELECT review_metadata->>'semantic_tag'                        AS tag,
               COUNT(*)::int                                           AS n,
               SUM((review_metadata->>'verdict'='pass')::int)::int     AS pass_n,
               SUM((review_metadata->>'verdict'='partial')::int)::int  AS partial_n,
               SUM((review_metadata->>'verdict'='fail')::int)::int     AS fail_n,
               AVG((review_metadata->>'overall_score')::float)         AS avg_overall
        FROM sim_run
        WHERE review_metadata IS NOT NULL
          AND review_metadata->>'semantic_tag' IS NOT NULL
        GROUP BY tag
        ORDER BY n DESC
        LIMIT 20
      `),
      pool.query(`
        SELECT DATE_TRUNC('day', review_updated_at)::date              AS day,
               COUNT(*)::int                                           AS n,
               SUM((review_metadata->>'verdict'='pass')::int)::int     AS pass_n,
               SUM((review_metadata->>'verdict'='partial')::int)::int  AS partial_n,
               SUM((review_metadata->>'verdict'='fail')::int)::int     AS fail_n
        FROM sim_run
        WHERE review_metadata IS NOT NULL
          AND review_updated_at > now() - interval '30 days'
        GROUP BY day
        ORDER BY day
      `),
      pool.query(`
        SELECT key, COUNT(*)::int AS n
        FROM (
          SELECT jsonb_array_elements_text(review_metadata->'failed_parameter_keys') AS key
          FROM sim_run
          WHERE review_metadata IS NOT NULL
        ) t
        GROUP BY key
        ORDER BY n DESC
        LIMIT 10
      `),
      pool.query(`
        SELECT gds_filename,
               review_updated_at,
               review_metadata->>'verdict'                     AS verdict,
               (review_metadata->>'overall_score')::float      AS overall_score,
               (review_metadata->>'semantic_match_score')::float AS semantic_score,
               review_metadata->>'semantic_tag'                AS semantic_tag,
               review_metadata->'failed_parameter_keys'        AS failed_keys
        FROM sim_run
        WHERE review_metadata IS NOT NULL
        ORDER BY review_updated_at DESC
        LIMIT 20
      `),
    ]);

    return NextResponse.json({
      overall:     overall.rows[0] ?? {},
      by_tag:      byTag.rows,
      by_day:      byDay.rows,
      by_failed:   byFailedKey.rows,
      recent:      recent.rows,
    });
  } catch (e) {
    return NextResponse.json(
      { error: String(e) },
      { status: 500 },
    );
  }
}
