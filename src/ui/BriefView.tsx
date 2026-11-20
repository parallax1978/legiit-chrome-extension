/** Renders a client brief. Used in the side panel and on the print page (white-label: agency identity, no Legiit branding). */
import type { Brief } from '@/features/instant-brief/compose';

export function BriefSections({ brief }: { brief: Brief }) {
  return (
    <>
      {brief.sections.map((section) => (
        <section key={section.id} data-testid={`brief-${section.id}`}>
          <h2>{section.title}</h2>
          {section.note && <p className="note small muted">{section.note}</p>}
          {section.paragraphs.map((paragraph, i) => (
            <p key={i} className="break">
              {paragraph}
            </p>
          ))}
          {section.facts.length > 0 && (
            <dl className="facts">
              {section.facts.map((fact) => (
                <div key={fact.label} style={{ display: 'contents' }}>
                  <dt>{fact.label}</dt>
                  <dd>{fact.value}</dd>
                </div>
              ))}
            </dl>
          )}
          {section.lists.map((list) => (
            <div key={list.label}>
              <h3>{list.label}</h3>
              <ul className="break">
                {list.items.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      ))}
    </>
  );
}
