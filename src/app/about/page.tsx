import Link from 'next/link';

export const metadata = { title: 'About — Nightscript' };

/**
 * The quiet note the brief asks for. It states what this is not, once, without nagging, and
 * points at real support. It does not position the app as therapy or recovery care anywhere.
 */
export default function About() {
  return (
    <div className="mx-auto min-h-dvh w-full max-w-2xl px-5 pb-24 pt-6">
      <Link href="/" className="text-sm text-ink-400 hover:text-ink-200">
        ← Library
      </Link>

      <h1 className="mb-8 mt-4 text-xl font-normal text-ink-100">About</h1>

      <div className="space-y-6 text-sm leading-relaxed text-ink-300">
        <p>
          This is a personal practice, not treatment. It is not therapy, not recovery care, and
          not a substitute for either. If something here is standing in for support you actually
          need, please talk to someone real.
        </p>
        <p className="text-ink-400">
          In the UK: <span className="text-ink-200">Samaritans, 116 123</span>, free, any time.{' '}
          <a
            href="https://www.nhs.uk/service-search/mental-health"
            className="underline decoration-ink-600 hover:text-ink-200"
            target="_blank"
            rel="noreferrer"
          >
            NHS mental health services
          </a>
          . For alcohol or drugs,{' '}
          <a
            href="https://www.talktofrank.com"
            className="underline decoration-ink-600 hover:text-ink-200"
            target="_blank"
            rel="noreferrer"
          >
            Talk to FRANK
          </a>
          .
        </p>

        <hr className="border-ink-850" />

        <h2 className="text-base text-ink-200">Why the lines are worded the way they are</h2>
        <p>
          Most affirmation apps hand you absolutes — &ldquo;I am confident&rdquo;, &ldquo;I am
          successful&rdquo;. There is a well-known 2009 study showing that repeating statements
          like that makes people with low self-esteem feel <em>worse</em>, because the mind
          immediately goes looking for counter-evidence. The people who most need it are the
          people it hurts.
        </p>
        <p>
          So nothing here claims a trait you do not feel you have. Lines are written as
          something underway, as your own past evidence, as kindness about the difficulty, as
          what you value, or as a specific plan for a specific moment. The 1-to-10 rating you
          give each goal decides which of those are allowed to be used at all.
        </p>
        <p>
          Some lines will name the part of you that disagrees. That is deliberate, and it is the
          condition in the original study that removed the harm: allowing the contradicting
          thought beats arguing past it.
        </p>
        <p>
          The specific-plan lines — &ldquo;when the alarm goes at six, I put my feet on the
          floor&rdquo; — are the part with the strongest evidence behind them by a distance. If
          only one thing in the hour does anything, it is those.
        </p>

        <h2 className="text-base text-ink-200">What an hour of audio can and cannot do</h2>
        <p>
          Honestly: learning new things while genuinely asleep is not supported by the evidence.
          What is supported is that sound played during sleep can re-activate material you
          engaged with while awake, and that the minutes before sleep are an unusually
          undistracted time to hear something.
        </p>
        <p>
          So the track front-loads its content into the first half hour, while you may still be
          awake, and everything after that is built to do nothing rather than to teach —
          quieter, slower, more spaced, until it fades out entirely. If you are asleep by minute
          twelve, nothing later is designed to reach you.
        </p>

        <h2 className="text-base text-ink-200">Where your words go</h2>
        <p>
          Your goals, your script and your finished audio live in this browser, on this device.
          There is no account and no server-side copy. When you generate audio, the script is
          sent to Google&rsquo;s API to be spoken and to this app&rsquo;s own server process to
          be assembled with ffmpeg; both copies are deleted as soon as the file reaches you.
        </p>
        <p>
          A generated track is yours permanently and costs nothing to replay. Clearing this
          browser&rsquo;s storage deletes it.
        </p>

        <h2 className="text-base text-ink-200">What this app will never do</h2>
        <p className="text-ink-400">
          No streaks. No badges. No reminders. No notification asking why you missed last night.
          Nothing that turns a night you did not use it into a failure. It runs at bedtime for
          someone trying to sleep, and every retention mechanic is a reason to be awake.
        </p>
      </div>
    </div>
  );
}
