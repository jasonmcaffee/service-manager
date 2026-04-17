

# API
We want to be able to use an api to stop/start services.

Create an api that allows: 
## List services 
return all configured services.  This already exists. ensure it:
We also want their ports, cuda devices, and scripts to be returned.

## List profiles
list all profiles.  include what each service cuda device is, port.

## Switch profile
Switch run profile.  should behave just like the ui in that all services are stopped, started, etc.

# Client Library
we want a client library as folder under root.  it should have it's own package.json, build etc.
it should be typescript.
we should update our tests to use the client, and confirm it works.
We want other projects to be able to install the library, by pointing to our local dir (it's not going to be published to npm).

Include a readme that provides installation instructions, so I can install it in other projects (absolute path to project would be good)


