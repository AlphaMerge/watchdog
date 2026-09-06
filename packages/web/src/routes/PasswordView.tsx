import { ChangePasswordForm } from '../auth/ChangePasswordForm';
import { PageTitle } from '../components/PageTitle';
import { Card } from '../components/Panels';

/**
 * Changing your password when nothing is making you (`U-17`).
 *
 * The same form the forced flow shows, in an ordinary page. Multi-factor enrolment belongs
 * beside it and is `A-07`'s API without a view yet — a ticket, not a gap here.
 */
export function PasswordView(): React.JSX.Element {
  return (
    <div className="space-y-4">
      <PageTitle title="Your password" />
      <div className="max-w-sm">
        <Card title="Change password">
          <ChangePasswordForm />
        </Card>
      </div>
    </div>
  );
}
