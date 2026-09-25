const form = document.querySelector('#login-form');
const status = document.querySelector('#status');
const submit = document.querySelector('#submit');
const submitLabel = document.querySelector('#submit-label');
const password = document.querySelector('#password');
const toggle = document.querySelector('#toggle-password');
const signedIn = document.querySelector('#signed-in');
const logout = document.querySelector('#logout');
const continueLink = document.querySelector('#continue');
let csrfToken;

function destination() {
    const value = new URLSearchParams(location.search).get('returnTo');
    return value && /^\/(?!\/)/.test(value) && !/[\\\x00-\x20]/.test(value)
        && !value.startsWith('/basic-auth') ? value : '/';
}

async function refreshSession({ updateUI = true } = {}) {
    const response = await fetch('/basic-auth/session', { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) throw new Error('Sign-in is unavailable. Refresh to try again.');
    const session = await response.json();
    csrfToken = session.token;
    if (updateUI) {
        form.hidden = session.authenticated;
        signedIn.hidden = !session.authenticated;
        continueLink.href = destination();
        submit.disabled = false;
    }
    return session;
}

toggle.addEventListener('click', () => {
    const visible = password.type === 'password';
    password.type = visible ? 'text' : 'password';
    toggle.setAttribute('aria-label', visible ? 'Hide password' : 'Show password');
    toggle.setAttribute('aria-pressed', String(visible));
    toggle.title = visible ? 'Hide password' : 'Show password';
});

form.addEventListener('submit', async event => {
    event.preventDefault();
    submit.disabled = true;
    submitLabel.textContent = 'Signing in...';
    status.textContent = '';
    try {
        await refreshSession({ updateUI: false });
        const response = await fetch('/basic-auth/login', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrfToken },
            body: JSON.stringify({ username: document.querySelector('#username').value, password: password.value, returnTo: destination() }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Unable to sign in. Please try again.');
        const session = await refreshSession({ updateUI: false });
        if (!session.authenticated) {
            throw new Error('Your browser did not retain the login cookie. Use HTTPS and allow cookies for this site.');
        }
        location.assign(result.redirect);
    } catch (error) {
        status.textContent = error.message || 'Unable to connect. Please try again.';
    } finally {
        submit.disabled = false;
        submitLabel.textContent = 'Sign in';
    }
});

logout.addEventListener('click', async () => {
    logout.disabled = true;
    try {
        await refreshSession();
        const response = await fetch('/basic-auth/logout', {
            method: 'POST', credentials: 'same-origin', headers: { 'x-csrf-token': csrfToken },
        });
        if (!response.ok) throw new Error('Unable to sign out. Please try again.');
        location.replace('/basic-auth/login');
    } catch (error) {
        logout.textContent = error.message || 'Unable to connect. Try again.';
    } finally {
        logout.disabled = false;
    }
});

refreshSession().catch(error => { status.textContent = error.message || 'Unable to connect. Refresh to try again.'; });
